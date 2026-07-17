import Object from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ShellyIndicator = Object.registerClass(
    class ShellyIndicator extends PanelMenu.Button {
        _init(extensionPath) {
            super._init(0.0, 'Shelly Cover Control');
            
            this._stateFile = Gio.File.new_for_path(extensionPath).get_child('state.json').get_path();

            // 1. Single container layout
            this._container = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
            });

            // 2. Single label for emoji and status
            this._statusLabel = new St.Label({
                text: '🪟 --',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-button-text'
            });
            this._container.add_child(this._statusLabel);
            this.add_child(this._container);

            // Connection & Subprocess states
            this._soupSession = new Soup.Session();
            this._selectedShellyIp = this._loadSavedIp(); 
            this._discoveredDevices = []; 
            this._pollTimeoutId = null;
            this._currentSubprocess = null; // Track subprocess to prevent overlaps

            // Build Static Control UI
            this._createControlUI();

            // Build Dynamic Discovery UI
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const discoveryHeader = new PopupMenu.PopupSubMenuMenuItem('Select Shelly Device');
            this.menu.addMenuItem(discoveryHeader);
            this._deviceSubMenu = discoveryHeader.menu;

            // Monitor system sleep/wake
            this._setupSleepMonitor();

            // Trigger initial discovery and start status updates
            this._discoverShellyDevices();
            this._startPolling();
        }

        /**
         * Tracks Linux DBus session changes (Sleep, Wake up, Lock)
         */
        _setupSleepMonitor() {
            // Monitor standard screen/session lock & sleep signals
            this._screenSaverProxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.session,
                g_name: 'org.gnome.ScreenSaver',
                g_object_path: '/org/gnome/ScreenSaver',
                g_interface_name: 'org.gnome.ScreenSaver'
            });

            // Signal listener for wake/lock
            this._screenSaverSignalId = this._screenSaverProxy.connect('g-properties-changed', (proxy, changedProperties) => {
                let active = changedProperties.lookup_value('Active', null);
                if (active) {
                    let isLocked = active.get_boolean();
                    if (!isLocked) {
                        console.log('Shelly: Desktop Unlocked / Resumed. Waiting for network...');
                        this._handleResumeRecover();
                    } else {
                        // Desktop is locked / going to sleep. Suspend calls.
                        this._stopPolling();
                        this._killCurrentDiscovery();
                    }
                }
            });
        }

        _handleResumeRecover() {
            // Stop any dangling tasks
            this._stopPolling();
            this._killCurrentDiscovery();

            // Wait 3 seconds to let network card establish a stable Wi-Fi/Ethernet IP, then scan
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                console.log('Shelly: Running post-resume discovery scan.');
                this._discoverShellyDevices();
                this._startPolling();
                return GLib.SOURCE_REMOVE;
            });
        }

        _loadSavedIp() {
            try {
                let [ok, contents] = GLib.file_get_contents(this._stateFile);
                if (ok) {
                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(contents));
                    return data.savedIp || null;
                }
            } catch (e) {
                console.log('Shelly: No saved state found.');
            }
            return null;
        }

        _saveSelectedIp(ip) {
            try {
                const data = JSON.stringify({ savedIp: ip }, null, '\t');
                GLib.file_set_contents(this._stateFile, data);
            } catch (error) {
                logError(error, 'Shelly: Failed to save state file');
            }
        }

        _createControlUI() {
            this._createMenuItem('Open Cover', 'Cover.Open');
            this._createMenuItem('Close Cover', 'Cover.Close');
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._createMenuItem('Stop Movement', 'Cover.Stop');
        }

        _createMenuItem(label, rpcMethod) {
            const item = new PopupMenu.PopupMenuItem(label);
            this.menu.addMenuItem(item);
            item.connect('activate', () => {
                this._sendShellyCommand(rpcMethod);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    this._queryShellyStatus();
                    return GLib.SOURCE_REMOVE;
                });
            });
        }

        _killCurrentDiscovery() {
            if (this._currentSubprocess) {
                try {
                    this._currentSubprocess.force_exit();
                } catch (e) {}
                this._currentSubprocess = null;
            }
        }

        /**
         * Runs an active 2.5-second scan to catch slower Wi-Fi/UDP mDNS responses.
         * Removing the '-t' flag allows us to listen continuously for incoming broadcasts.
         */
        _discoverShellyDevices() {
            this._killCurrentDiscovery(); // Clean up any active scans

            // We drop '-t' so the command stays open and listens
            const cmd = ['avahi-browse', '-rp', '_http._tcp'];

            try {
                this._currentSubprocess = Gio.Subprocess.new(cmd, Gio.SubprocessFlags.STDOUT_PIPE);

                // Set a 2.5-second timer to cleanly close the scan
                const scanTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                    this._killCurrentDiscovery();
                    return GLib.SOURCE_REMOVE;
                });

                this._currentSubprocess.communicate_utf8_async(null, null, (proc, res) => {
                    // Cancel our timeout guard if the process somehow exited on its own
                    GLib.Source.remove(scanTimeoutId);

                    try {
                        let [, stdout] = proc.communicate_utf8_finish(res);
                        if (stdout) {
                            this._parseAvahiOutput(stdout);
                        }
                    } catch (e) {
                        // Suppress errors caused by our manual force_exit() kill
                    } finally {
                        this._currentSubprocess = null;
                    }
                });
            } catch (e) {
                logError(e, 'Failed to launch avahi-browse');
            }
        }

        /**
         * Parses semicolon-separated output and queries each Shelly's HTTP API.
         * Explicitly filters to include only devices in 'cover' profile mode.
         */
        _parseAvahiOutput(stdout) {
            const lines = stdout.split('\n');
            const foundIps = [];

            for (let line of lines) {
                const parts = line.split(';');
                if (parts[0] === '=' && parts[2] === 'IPv4') {
                    const name = parts[3];
                    const ip = parts[7];

                    if (name && ip && name.toLowerCase().includes('shelly')) {
                        if (!foundIps.includes(ip)) {
                            foundIps.push(ip);
                        }
                    }
                }
            }

            this._discoveredDevices = [];

            if (foundIps.length === 0) {
                this._updateDeviceMenu();
                return;
            }

            foundIps.forEach(ip => {
                const url = `http://${ip}/rpc/Shelly.GetDeviceInfo`;
                const message = Soup.Message.new('GET', url);

                this._soupSession.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (session, result) => {
                        try {
                            const responseBytes = session.send_and_read_finish(result);
                            if (message.get_status() === 200) {
                                const decoder = new TextDecoder('utf-8');
                                const responseText = decoder.decode(responseBytes.get_data());
                                const deviceInfo = JSON.parse(responseText);

                                // --- COVER FILTER LOGIC ---
                                // 1. Multi-profile devices (like 2PM) explicitly announce their profile mode
                                const isCoverProfile = deviceInfo.profile === 'cover';

                                // 2. Alternatively, catch dedicated cover devices or filter out single-relays (like Plus1PM)
                                const appName = deviceInfo.app || '';
                                const isCompatibleHardware = appName.includes('2PM') || appName.toLowerCase().includes('cover');

                                // Only add if it's explicitly set to cover mode or is matching hardware
                                if (isCoverProfile || (isCompatibleHardware && deviceInfo.profile !== 'switch')) {
                                    const displayName = deviceInfo.name || deviceInfo.id;

                                    if (!this._discoveredDevices.some(d => d.ip === ip)) {
                                        this._discoveredDevices.push({ name: displayName, ip });
                                        this._updateDeviceMenu();
                                    }
                                } else {
                                    console.log(`Shelly: Skipping ${deviceInfo.id} (${ip}) because it is not in cover mode.`);
                                }
                                // --------------------------
                            }
                        } catch (error) {
                            // If a device fails to reply entirely, we can gracefully skip it
                            // to keep the list clean from non-functional or legacy devices
                            console.log(`Shelly: Could not verify features for device at ${ip}`);
                        }
                    }
                );
            });
        }

        _updateDeviceMenu() {
            this._deviceSubMenu.removeAll();

            if (this._discoveredDevices.length === 0) {
                const noDevicesItem = new PopupMenu.PopupMenuItem('No Shellys found. Rescan?');
                this._deviceSubMenu.addMenuItem(noDevicesItem);
                noDevicesItem.connect('activate', () => this._discoverShellyDevices());
                return;
            }

            this._discoveredDevices.sort((a, b) => {
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
            });

            if (!this._selectedShellyIp && this._discoveredDevices.length > 0) {
                this._selectedShellyIp = this._discoveredDevices[0].ip;
                this._saveSelectedIp(this._selectedShellyIp);
                this._queryShellyStatus();
            }

            this._discoveredDevices.forEach(device => {
                const isSelected = device.ip === this._selectedShellyIp;
                const label = isSelected ? `● ${device.name} (${device.ip})` : `○ ${device.name}`;
                const item = new PopupMenu.PopupMenuItem(label);
                this._deviceSubMenu.addMenuItem(item);

                item.connect('activate', () => {
                    this._selectedShellyIp = device.ip;
                    this._saveSelectedIp(device.ip); 
                    Main.notify('Shelly Connected', `Targeting: ${device.name}`);
                    this._updateDeviceMenu();
                    this._queryShellyStatus();
                });
            });

            if (this._selectedShellyIp) {
                this._deviceSubMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                const openWebUiItem = new PopupMenu.PopupMenuItem('🌐 Open Web Interface');
                this._deviceSubMenu.addMenuItem(openWebUiItem);
                openWebUiItem.connect('activate', () => {
                    const url = `http://${this._selectedShellyIp}/`;
                    try {
                        Gio.AppInfo.launch_default_for_uri(url, null);
                    } catch (error) {
                        logError(error, `Failed to open Web UI for ${this._selectedShellyIp}`);
                    }
                });
            }

            this._deviceSubMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const refreshItem = new PopupMenu.PopupMenuItem('🔄 Refresh Device List');
            this._deviceSubMenu.addMenuItem(refreshItem);
            refreshItem.connect('activate', () => this._discoverShellyDevices());
        }

        _startPolling() {
            this._stopPolling(); // Ensure timers are cleared first
            this._pollTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 
                5, 
                () => {
                    this._queryShellyStatus();
                    return GLib.SOURCE_CONTINUE; 
                }
            );
        }

        _stopPolling() {
            if (this._pollTimeoutId) {
                GLib.Source.remove(this._pollTimeoutId);
                this._pollTimeoutId = null;
            }
        }

        _queryShellyStatus() {
            if (!this._selectedShellyIp) {
                this._statusLabel.set_text(' 🪟 --');
                return;
            }

            const url = `http://${this._selectedShellyIp}/rpc/Cover.GetStatus?id=0`;
            const message = Soup.Message.new('GET', url);

            this._soupSession.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        const responseBytes = session.send_and_read_finish(result);
                        if (message.get_status() === 200) {
                            const decoder = new TextDecoder('utf-8');
                            const responseText = decoder.decode(responseBytes.get_data());
                            const status = JSON.parse(responseText);
                            this._updateStatusLabel(status);
                        } else {
                            this._statusLabel.set_text(' 🪟 Err');
                        }
                    } catch (error) {
                        this._statusLabel.set_text(' 🪟 Off');
                    }
                }
            );
        }

        _updateStatusLabel(status) {
            const state = status.state;
            const pos = status.current_pos;

            if (state === 'opening') {
                this._statusLabel.set_text('🪟 ▲');
            } else if (state === 'closing') {
                this._statusLabel.set_text('🪟 ▼');
            } else if (typeof pos === 'number') {
                this._statusLabel.set_text(`🪟 ${pos}%`);
            } else if (state === 'open') {
                this._statusLabel.set_text('🪟 100%');
            } else if (state === 'closed') {
                this._statusLabel.set_text('🪟 0%');
            } else {
                this._statusLabel.set_text('🪟 --');
            }
        }

        _sendShellyCommand(method) {
            if (!this._selectedShellyIp) return;

            const url = `http://${this._selectedShellyIp}/rpc/${method}`;
            const payload = JSON.stringify({ id: 0 });
            const message = Soup.Message.new('POST', url);
            const bytes = new GLib.Bytes(payload);
            message.set_request_body_from_bytes('application/json', bytes);

            this._soupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, () => {});
        }

        destroy() {
            this._stopPolling();
            this._killCurrentDiscovery();
            if (this._screenSaverProxy && this._screenSaverSignalId) {
                this._screenSaverProxy.disconnect(this._screenSaverSignalId);
            }
            super.destroy();
        }
    }
);

export default class ShellyCoverExtension extends Extension {
    enable() {
        this._indicator = new ShellyIndicator(this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
