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
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const ShellyIndicator = Object.registerClass(
    class ShellyIndicator extends PanelMenu.Button {
        _init(extensionPath, metadata) {
            super._init(0.0, 'Shelly Cover Control');
            
            this._metadata = metadata || {};
            this._stateFile = Gio.File.new_for_path(extensionPath).get_child('state.json');
            this._networkAvailable = true;

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

            // HTTP sessions
            this._soupSession = new Soup.Session();

            // Dedicated session for full-subnet sweeps: raised max_conns so
            // ~250 simultaneous probes aren't serialized behind libsoup's
            // default cap of 10, and it's aborted separately from
            // _soupSession so a sweep in flight can't block status polling.
            this._scanSoupSession = new Soup.Session({
                max_conns: 128,
                max_conns_per_host: 128,
            });
            this._subnetScanActive = false;

            this._selectedShellyIp = null; // Will load asynchronously
            this._discoveredDevices = []; 
            
            // Trackers to guarantee memory-leak prevention (GJS audit compliance)
            this._pollTimeoutId = null;
            this._resumeTimeoutId = null;
            this._feedbackTimeoutId = null;

            // Build Static Control UI
            this._createControlUI();

            // Network status warning — lives in the MAIN menu (not the device
            // submenu), hidden unless no local network route can be found.
            // Created with reactive:true (default) so GNOME Shell doesn't
            // auto-apply its "popup-inactive-menu-item" dimming class, then
            // made non-interactive by assigning reactive/can_focus afterward
            // — the label additionally gets an explicit white color rule
            // (see stylesheet.css) so it can never inherit a dimmed color.
            this._networkWarningItem = new PopupMenu.PopupMenuItem(
                '⚠️ No local network connection found'
            );
            this._networkWarningItem.reactive = false;
            this._networkWarningItem.can_focus = false;
            this._networkWarningItem.visible = false;
            this._networkWarningItem.label.add_style_class_name('shelly-menu-info-label');
            this.menu.addMenuItem(this._networkWarningItem);

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

            // About — always the last item in the menu
            const aboutItem = new PopupMenu.PopupMenuItem('ℹ️ About');
            this.menu.addMenuItem(aboutItem);
            aboutItem.connect('activate', () => this._showAboutDialog());

            // Monitor system sleep/wake
            this._setupSleepMonitor();

            // Load saved settings asynchronously, then trigger scans
            this._loadSavedIpAsync();
        }

        /**
         * Shows a small modal dialog with the extension's name, version,
         * GitHub page, and donation link.
         */
        _showAboutDialog() {
            const name = this._metadata.name || 'Shelly Cover Control';
            const version = this._metadata.version ?? this._metadata['version-name'] ?? 'unknown';
            const githubUrl = 'https://github.com/firebirdberlin/shelly-cover-control';
            const donateUrl = 'https://www.buymeacoffee.com/firebirdberlin';

            const dialog = new ModalDialog.ModalDialog({
                styleClass: 'shelly-about-dialog',
                destroyOnClose: true,
            });

            const content = new St.BoxLayout({
                vertical: true,
                style_class: 'shelly-about-content',
            });

            content.add_child(new St.Label({
                text: name,
                style_class: 'shelly-about-title',
            }));

            content.add_child(new St.Label({
                text: `Version ${version}`,
                style_class: 'shelly-about-version',
            }));

            const githubButton = new St.Button({
                label: '🔗 github.com/firebirdberlin/shelly-cover-control',
                style_class: 'shelly-about-link',
                x_align: Clutter.ActorAlign.START,
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            githubButton.connect('clicked', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(githubUrl, null);
                } catch (error) {
                    console.error(`Failed to open GitHub page: ${error.message}`);
                }
            });
            content.add_child(githubButton);

            const donateButton = new St.Button({
                label: '☕ Buy me a coffee',
                style_class: 'shelly-about-link',
                x_align: Clutter.ActorAlign.START,
                can_focus: true,
                reactive: true,
                track_hover: true,
            });
            donateButton.connect('clicked', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(donateUrl, null);
                } catch (error) {
                    console.error(`Failed to open donation link: ${error.message}`);
                }
            });
            content.add_child(donateButton);

            dialog.contentLayout.add_child(content);

            dialog.setButtons([
                {
                    label: 'Close',
                    action: () => dialog.close(),
                    key: Clutter.KEY_Escape,
                    default: true,
                },
            ]);

            dialog.open();
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
                        this._abortDiscovery();
                    }
                }
            });
        }

        _handleResumeRecover() {
            this._stopPolling();
            this._abortDiscovery();

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

        /**
         * Cancels any in-flight subnet-scan HTTP requests (used on sleep/lock
         * so a sweep in progress doesn't keep hammering the network while
         * suspended). The session itself remains reusable afterward.
         */
        _abortDiscovery() {
            if (this._scanSoupSession) {
                this._scanSoupSession.abort();
            }
            this._subnetScanActive = false;
        }

        /**
         * Determines the local IPv4 address used for outbound traffic by
         * asking the kernel to route a UDP "connection" to a reserved,
         * never-routed address (192.0.2.1, RFC 5737 TEST-NET-1). No packets
         * are actually sent — UDP connect() only resolves which local
         * interface/address the routing table would use — so this is
         * instant and needs no external tool (no avahi, no `ip` command,
         * no NetworkManager dependency).
         */
        _getLocalIpAddress() {
            let socket = null;
            try {
                socket = Gio.Socket.new(
                    Gio.SocketFamily.IPV4,
                    Gio.SocketType.DATAGRAM,
                    Gio.SocketProtocol.UDP
                );

                const remote = Gio.InetSocketAddress.new(
                    Gio.InetAddress.new_from_string('192.0.2.1'),
                    80
                );
                socket.connect(remote, null);

                const local = socket.get_local_address();
                const address = local ? local.get_address().to_string() : null;

                // 0.0.0.0 means the kernel couldn't resolve a route at all.
                return address && address !== '0.0.0.0' ? address : null;
            } catch (e) {
                return null;
            } finally {
                if (socket) {
                    try {
                        socket.close();
                    } catch (e) {
                        // already closed / never opened — nothing to do
                    }
                }
            }
        }

        /**
         * Entry point for (re)discovery. Finds the local subnet via
         * _getLocalIpAddress() and sweeps it directly. No mDNS/avahi
         * involved at all — nothing is spawned, so there's no external tool
         * dependency and no risk of missing devices due to multicast being
         * dropped on Wi-Fi/VLANs the way mDNS discovery can be.
         */
        _discoverShellyDevices() {
            this._discoveredDevices = [];

            const localIp = this._getLocalIpAddress();

            if (!localIp) {
                this._networkAvailable = false;
                if (this._networkWarningItem) {
                    this._networkWarningItem.visible = true;
                }
                this._updateDeviceMenu();
                return;
            }

            if (!this._networkAvailable) {
                this._networkAvailable = true;
                if (this._networkWarningItem) {
                    this._networkWarningItem.visible = false;
                }
            }

            this._scanSubnetForDevices(localIp, [localIp]);
        }

        /**
         * Applies the cover/2PM compatibility filter to a Shelly.GetDeviceInfo
         * response and adds the device to the roster if it matches.
         */
        _registerDiscoveredDevice(ip, deviceInfo) {
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

        /**
         * Fetches Shelly.GetDeviceInfo from a single IP and registers it if
         * it matches. onComplete always fires exactly once (success,
         * non-match, timeout, or network error) so callers can track when a
         * batch of probes is done.
         */
        _probeShellyDevice(ip, onComplete) {
            const url = `http://${ip}/rpc/Shelly.GetDeviceInfo`;
            const message = Soup.Message.new('GET', url);
            const cancellable = new Gio.Cancellable();

            // Fast timeout so a full /24 sweep finishes quickly even though
            // most of the 254 addresses won't have anything listening.
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });

            this._scanSoupSession.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (session, result) => {
                    GLib.Source.remove(timeoutId);

                    try {
                        const responseBytes = session.send_and_read_finish(result);
                        if (message.get_status() === 200) {
                            const decoder = new TextDecoder('utf-8');
                            const responseText = decoder.decode(responseBytes.get_data());
                            const deviceInfo = JSON.parse(responseText);
                            this._registerDiscoveredDevice(ip, deviceInfo);
                        }
                    } catch (error) {
                        // Expected for the vast majority of scanned addresses
                        // (nothing listening, connection refused, timed out,
                        // or not a Shelly at all) — nothing to do.
                    } finally {
                        onComplete();
                    }
                }
            );
        }

        /**
         * Sweeps every host in the /24 that anchorIp belongs to, skipping any
         * IPs in excludeIps (typically the local machine's own address).
         */
        _scanSubnetForDevices(anchorIp, excludeIps = []) {
            const octets = anchorIp.split('.');
            if (octets.length !== 4) return;

            const prefix = `${octets[0]}.${octets[1]}.${octets[2]}`;
            const excludeSet = new Set(excludeIps);

            let pending = 0;
            this._subnetScanActive = true;
            this._updateDeviceMenu();

            const finishOne = () => {
                pending--;
                if (pending === 0) {
                    this._subnetScanActive = false;
                    this._updateDeviceMenu();
                }
            };

            for (let i = 1; i <= 254; i++) {
                const ip = `${prefix}.${i}`;
                if (excludeSet.has(ip)) continue;

                pending++;
                this._probeShellyDevice(ip, finishOne);
            }

            // Nothing to scan (shouldn't normally happen with a /24)
            if (pending === 0) {
                this._subnetScanActive = false;
                this._updateDeviceMenu();
            }
        }

        /**
         * Updates dropdown device roster. Guaranteed to always house 
         * at least one item, preventing sub-menu system locking.
         */
        _updateDeviceMenu() {
            this._deviceSubMenu.removeAll();

            if (this._subnetScanActive) {
                const scanningItem = new PopupMenu.PopupMenuItem('🔍 Scanning local network for devices…');
                scanningItem.reactive = false;
                scanningItem.can_focus = false;
                scanningItem.label.add_style_class_name('shelly-menu-info-label');
                this._deviceSubMenu.addMenuItem(scanningItem);
            }

            if (!this._networkAvailable) {
                this._setWebUiButtonSensitive(false);
            } else if (this._discoveredDevices.length > 0) {
                // 1. Populate actual found Shellys
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

            // Cancel any in-flight subnet-scan HTTP requests
            this._abortDiscovery();

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
            if (this._scanSoupSession) {
                this._scanSoupSession.abort();
                this._scanSoupSession = null;
            }

            super.destroy();
        }
    }
);

export default class ShellyCoverExtension extends Extension {
    enable() {
        this._indicator = new ShellyIndicator(this.path, this.metadata);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
