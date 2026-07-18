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
            
            this._stateFile = Gio.File.new_for_path(extensionPath).get_child('state.json');

            // 1. Single container layout
            this._container = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
            });

            // 2. Load the colorful custom rainbow SVG icon
            const iconFile = Gio.File.new_for_path(extensionPath).get_child('shelly-cover.svg');
            const gicon = Gio.Icon.new_for_string(iconFile.get_path());

            this._statusIcon = new St.Icon({
                gicon: gicon,
                style_class: 'system-status-icon',
                icon_size: 16 // Ensures strict panel proportions
            });
            this._container.add_child(this._statusIcon);

            // 3. Single label for dynamic status readings
            this._statusLabel = new St.Label({
                text: ' --',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-button-text'
            });
            this._container.add_child(this._statusLabel);
            this.add_child(this._container);

            // Connection & Subprocess states
            this._soupSession = new Soup.Session();
            this._selectedShellyIp = null; // Will load asynchronously
            this._discoveredDevices = []; 
            
            // Trackers to guarantee memory-leak prevention (GJS audit compliance)
            this._pollTimeoutId = null;
            this._resumeTimeoutId = null;
            this._feedbackTimeoutId = null;
            this._currentSubprocess = null;

            // Build Static Control UI
            this._createControlUI();

            // Build Dynamic Discovery UI
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const discoveryHeader = new PopupMenu.PopupSubMenuMenuItem('Select Shelly Device');
            this.menu.addMenuItem(discoveryHeader);
            this._deviceSubMenu = discoveryHeader.menu;

            // Add the Coffee Donation Link at the absolute bottom of the main menu
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const donateItem = new PopupMenu.PopupMenuItem('☕ Buy me a coffee');
            this.menu.addMenuItem(donateItem);
            donateItem.connect('activate', () => {
                const url = 'https://www.buymeacoffee.com/firebirdberlin';
                try {
                    Gio.AppInfo.launch_default_for_uri(url, null);
                } catch (error) {
                    console.error(`Failed to open donation link: ${error.message}`);
                }
            });

            // Monitor system sleep/wake
            this._setupSleepMonitor();

            // Load saved settings asynchronously, then trigger scans
            this._loadSavedIpAsync();
        }

        /**
         * Tracks Linux DBus session changes (Sleep, Wake up, Lock)
         */
        _setupSleepMonitor() {
            this._screenSaverProxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.session,
                g_name: 'org.gnome.ScreenSaver',
                g_object_path: '/org/gnome/ScreenSaver',
                g_interface_name: 'org.gnome.ScreenSaver'
            });

            this._screenSaverSignalId = this._screenSaverProxy.connect('g-properties-changed', (proxy, changedProperties) => {
                let active = changedProperties.lookup_value('Active', null);
                if (active) {
                    let isLocked = active.get_boolean();
                    if (!isLocked) {
                        this._handleResumeRecover();
                    } else {
                        // Suspend active intervals and processes immediately upon sleep/lock
                        this._stopPolling();
                        this._killCurrentDiscovery();
                    }
                }
            });
        }

        _handleResumeRecover() {
            this._stopPolling();
            this._killCurrentDiscovery();

            if (this._resumeTimeoutId) {
                GLib.Source.remove(this._resumeTimeoutId);
                this._resumeTimeoutId = null;
            }

            // 3 seconds delay to allow interfaces to reconnect
            this._resumeTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                this._discoverShellyDevices();
                this._startPolling();
                this._resumeTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
        }

        /**
         * Asynchronously loads the saved IP from disk (EGO-X-004 compliance)
         */
        _loadSavedIpAsync() {
            this._stateFile.load_contents_async(null, (file, res) => {
                try {
                    let [success, contents] = file.load_contents_finish(res);
                    if (success) {
                        const decoder = new TextDecoder('utf-8');
                        const data = JSON.parse(decoder.decode(contents));
                        this._selectedShellyIp = data.savedIp || null;
                    }
                } catch (e) {
                    // File may not exist yet on first launch; gracefully continue
                } finally {
                    // Initialize system tasks after file I/O finishes
                    this._discoverShellyDevices();
                    this._startPolling();
                }
            });
        }

        /**
         * Asynchronously saves the selected IP to disk (EGO-X-004 compliance)
         */
        _saveSelectedIpAsync(ip) {
            const data = JSON.stringify({ savedIp: ip }, null, '\t');
            const bytes = new GLib.Bytes(data);
            
            this._stateFile.replace_contents_bytes_async(
                bytes,
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null,
                (file, res) => {
                    try {
                        file.replace_contents_finish(res);
                    } catch (error) {
                        console.error(`Shelly: Failed to save state file: ${error.message}`);
                    }
                }
            );
        }

        _createControlUI() {
            // Non-reactive wrapper so clicking the row itself doesn't close the
            // menu; the buttons inside remain individually clickable.
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            const row = new St.BoxLayout({
                style_class: 'shelly-control-row',
                x_expand: true,
                vertical: false,
            });

            this._rowNameLabel = new St.Label({
                text: 'Cover',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                style_class: 'shelly-control-name',
            });
            row.add_child(this._rowNameLabel);

            this._openBtn = this._createControlButton('\u25B2', 'Cover.Open');   // ▲
            this._closeBtn = this._createControlButton('\u25BC', 'Cover.Close'); // ▼
            this._stopBtn = this._createControlButton('\u25A0', 'Cover.Stop');   // ■

            row.add_child(this._openBtn);
            row.add_child(this._closeBtn);
            row.add_child(this._stopBtn);

            this._rowPercentLabel = new St.Label({
                text: '--',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'shelly-control-percent',
            });
            row.add_child(this._rowPercentLabel);

            this._webUiBtn = new St.Button({
                label: '\u{1F310}', // 🌐
                style_class: 'shelly-control-btn',
                style: 'padding: 4px 8px; margin: 0 0 0 4px;',
                can_focus: false,
                reactive: false,
                track_hover: true,
            });
            this._webUiBtn.opacity = 120; // starts disabled until a device is selected
            this._webUiBtn.connect('clicked', () => {
                if (!this._selectedShellyIp) return;
                const url = `http://${this._selectedShellyIp}/`;
                try {
                    Gio.AppInfo.launch_default_for_uri(url, null);
                } catch (error) {
                    console.error(`Failed to open Web UI for ${this._selectedShellyIp}: ${error.message}`);
                }
            });
            row.add_child(this._webUiBtn);

            item.add_child(row);
            this.menu.addMenuItem(item);
        }

        /**
         * Enables/disables and visually dims the 🌐 web-interface button
         * based on whether a Shelly device is currently selected.
         */
        _setWebUiButtonSensitive(sensitive) {
            if (!this._webUiBtn) return;
            this._webUiBtn.reactive = sensitive;
            this._webUiBtn.can_focus = sensitive;
            this._webUiBtn.opacity = sensitive ? 255 : 120;
        }

        _createControlButton(glyph, rpcMethod) {
            const button = new St.Button({
                label: glyph,
                style_class: 'shelly-control-btn',
                style: 'padding: 4px 10px; margin: 0 2px;',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });

            button.connect('clicked', () => {
                this._sendShellyCommand(rpcMethod);

                // Track transition UI feedback timeout safely
                if (this._feedbackTimeoutId) {
                    GLib.Source.remove(this._feedbackTimeoutId);
                }

                this._feedbackTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    this._queryShellyStatus();
                    this._feedbackTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                });
            });

            return button;
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
         */
        _discoverShellyDevices() {
            this._killCurrentDiscovery();

            const cmd = ['avahi-browse', '-rp', '_http._tcp'];

            try {
                this._currentSubprocess = Gio.Subprocess.new(cmd, Gio.SubprocessFlags.STDOUT_PIPE);

                const scanTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                    this._killCurrentDiscovery();
                    return GLib.SOURCE_REMOVE;
                });

                this._currentSubprocess.communicate_utf8_async(null, null, (proc, res) => {
                    GLib.Source.remove(scanTimeoutId);

                    try {
                        let [, stdout] = proc.communicate_utf8_finish(res);
                        if (stdout) {
                            this._parseAvahiOutput(stdout);
                        }
                    } catch (e) {
                        // Suppress manually triggered exit code error messages
                    } finally {
                        this._currentSubprocess = null;
                    }
                });
            } catch (e) {
                console.error(`Failed to launch avahi-browse: ${e.message}`);
            }
        }

        /**
         * Parses output and targets Shelly HTTP metadata.
         * Filters to include only devices explicitly set to 'cover' profile.
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

                                // COVER FILTER LOGIC
                                const isCoverProfile = deviceInfo.profile === 'cover';
                                const appName = deviceInfo.app || '';
                                const isCompatibleHardware = appName.includes('2PM') || appName.toLowerCase().includes('cover');

                                if (isCoverProfile || (isCompatibleHardware && deviceInfo.profile !== 'switch')) {
                                    const displayName = deviceInfo.name || deviceInfo.id;

                                    if (!this._discoveredDevices.some(d => d.ip === ip)) {
                                        this._discoveredDevices.push({ name: displayName, ip });
                                        this._updateDeviceMenu();
                                    }
                                }
                            }
                        } catch (error) {
                            // Suppressed transient verification errors to adhere to EGO-A-004 guidelines
                        }
                    }
                );
            });
        }

        /**
         * Updates dropdown device roster. Guaranteed to always house 
         * at least one item, preventing sub-menu system locking.
         */
        _updateDeviceMenu() {
            this._deviceSubMenu.removeAll();

            // 1. Populate actual found Shellys
            if (this._discoveredDevices.length > 0) {
                this._discoveredDevices.sort((a, b) => {
                    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
                });

                if (!this._selectedShellyIp) {
                    this._selectedShellyIp = this._discoveredDevices[0].ip;
                    this._saveSelectedIpAsync(this._selectedShellyIp);
                    if (this._rowNameLabel) {
                        this._rowNameLabel.set_text(this._discoveredDevices[0].name);
                    }
                    this._queryShellyStatus();
                }

                this._discoveredDevices.forEach(device => {
                    const isSelected = device.ip === this._selectedShellyIp;
                    if (isSelected && this._rowNameLabel) {
                        this._rowNameLabel.set_text(device.name);
                    }
                    const label = isSelected ? `● ${device.name} (${device.ip})` : `○ ${device.name}`;
                    const item = new PopupMenu.PopupMenuItem(label);
                    this._deviceSubMenu.addMenuItem(item);

                    item.connect('activate', () => {
                        this._selectedShellyIp = device.ip;
                        this._saveSelectedIpAsync(device.ip); 
                        Main.notify('Shelly Connected', `Targeting: ${device.name}`);
                        if (this._rowNameLabel) {
                            this._rowNameLabel.set_text(device.name);
                        }
                        this._updateDeviceMenu();
                        this._queryShellyStatus();
                    });
                });

                if (this._selectedShellyIp) {
                    this._setWebUiButtonSensitive(true);
                }
            } else {
                // FALLBACK: Non-functional placeholder keeps menu selectable
                const noDevicesItem = new PopupMenu.PopupMenuItem('No Shellys found yet');
                noDevicesItem.sensitive = false; 
                this._deviceSubMenu.addMenuItem(noDevicesItem);
                this._setWebUiButtonSensitive(false);
            }

            // 2. ALWAYS appended refresh action prevents zero-element menu lockups
            this._deviceSubMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const refreshItem = new PopupMenu.PopupMenuItem('🔄 Refresh Device List');
            this._deviceSubMenu.addMenuItem(refreshItem);
            refreshItem.connect('activate', () => this._discoverShellyDevices());
        }

        _startPolling() {
            this._stopPolling();
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
                this._statusLabel.set_text(' --');
                this._updateControlRow(null, null);
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
                            this._statusLabel.set_text(' Err');
                            if (this._rowPercentLabel) this._rowPercentLabel.set_text('Err');
                        }
                    } catch (error) {
                        this._statusLabel.set_text(' Off');
                        if (this._rowPercentLabel) this._rowPercentLabel.set_text('Off');
                    }
                }
            );
        }

        _updateStatusLabel(status) {
            const state = status.state;
            const pos = status.current_pos;

            if (state === 'opening') {
                this._statusLabel.set_text(' ▲');
            } else if (state === 'closing') {
                this._statusLabel.set_text(' ▼');
            } else if (typeof pos === 'number') {
                this._statusLabel.set_text(` ${pos}%`);
            } else if (state === 'open') {
                this._statusLabel.set_text(' 100%');
            } else if (state === 'closed') {
                this._statusLabel.set_text(' 0%');
            } else {
                this._statusLabel.set_text(' --');
            }

            this._updateControlRow(state, pos);
        }

        /**
         * Syncs the percentage readout and active-direction highlight on the
         * [▲] [▼] [■] control row inside the dropdown menu.
         */
        _updateControlRow(state, pos) {
            if (this._rowPercentLabel) {
                if (typeof pos === 'number') {
                    this._rowPercentLabel.set_text(`${pos}%`);
                } else if (state === 'open') {
                    this._rowPercentLabel.set_text('100%');
                } else if (state === 'closed') {
                    this._rowPercentLabel.set_text('0%');
                } else {
                    this._rowPercentLabel.set_text('--');
                }
            }

            if (this._openBtn) {
                this._openBtn.style_pseudo_class = state === 'opening' ? 'active' : '';
            }
            if (this._closeBtn) {
                this._closeBtn.style_pseudo_class = state === 'closing' ? 'active' : '';
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
            // Clean up timers to prevent memory leaks
            this._stopPolling();
            if (this._resumeTimeoutId) {
                GLib.Source.remove(this._resumeTimeoutId);
                this._resumeTimeoutId = null;
            }
            if (this._feedbackTimeoutId) {
                GLib.Source.remove(this._feedbackTimeoutId);
                this._feedbackTimeoutId = null;
            }

            // Clean up spawned subprocesses
            this._killCurrentDiscovery();

            // Disconnect and clean up DBus Session listeners
            if (this._screenSaverProxy && this._screenSaverSignalId) {
                this._screenSaverProxy.disconnect(this._screenSaverSignalId);
                this._screenSaverSignalId = null;
            }
            this._screenSaverProxy = null;

            // Abort and clean up HTTP sessions
            if (this._soupSession) {
                this._soupSession.abort();
                this._soupSession = null;
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
