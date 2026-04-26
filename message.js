/* ===================================================================
   EMERGENCY COMMAND MESSENGER — APPLICATION LOGIC v3.0
   Robust messaging system with: Admin/Guest roles, webcam fire detection,
   AI emergency instructions, dynamic room status.
   
   INTEGRATION API (window.EmergencyMessenger):
   - .sendMessage(channelId, text, severity)
   - .broadcastAlert(severity, incidentType, floor, message)
   - .addChannel(name, type, icon)
   - .getChannels()
   - .getMessages(channelId)
   - .onMessage(callback)
   - .onBroadcast(callback)
   - .onAlert(callback)
   - .setCurrentUser(name, role)
   - .switchRole(role)
   =================================================================== */

;(function () {
    'use strict';
    
    // ======================== CONFIG & API ========================
    const CONFIG = window.CONFIG_OVERRIDE || {
        NODE_API: window.location.hostname === 'localhost' ? 'http://localhost:5000' : window.location.origin.replace(':3000', ':5000'),
    };
    const API_BASE = CONFIG.NODE_API;

    async function apiFetch(path) {
        try {
            const resp = await fetch(API_BASE + path);
            if (!resp.ok) throw new Error(path + ' -> ' + resp.status);
            return await resp.json();
        } catch (e) {
            console.error('[API ERROR]', e.message);
            return null;
        }
    }

    async function apiPost(path, data) {
        try {
            const resp = await fetch(API_BASE + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (!resp.ok) throw new Error(path + ' -> ' + resp.status);
            return await resp.json();
        } catch (e) {
            console.error('[API POST ERROR]', e.message);
            return null;
        }
    }

    // ======================== HOSPITAL FLOOR PLAN (Dynamic) ========================
    let FLOOR_PLAN = {
        '1': { name: 'Entire Building', shortName: 'Main Floor', rooms: [] }
    };

    // ======================== STATE ========================
    let allUsers = [];
    const state = {
        currentUser: { name: 'Admin', initials: 'AD', role: 'Administrator', id: 'admin-001' },
        currentRole: 'admin', // 'admin' or 'guest'
        assignedRoom: null,   // e.g., '201' when in guest mode
        assignedFloor: null,  // e.g., '2' when in guest mode
        currentChannelId: 'all-emergency',
        currentSeverity: 'normal',
        incidentActive: false,
        incidentStartTime: null,
        incidentType: null,
        incidentFloor: null,
        channels: [],
        messages: {},
        alerts: [],
        staff: [],
        rooms: {},       // floorKey -> [{num, status, lastUpdate}]
        eventListeners: {
            message: [],
            broadcast: [],
            alert: [],
            channelChange: []
        },
        geminiApiKey: 'AIzaSyAmLpeaUyG1xRLz8kTFoiuKY2lLM0hlQa8',
        webcamStream: null,
        webcamInterval: null,
        detectionActive: false,
        settings: {
            soundEnabled: true,
            showTimestamps: true,
            showAvatars: true
        },
        _confirmCallback: null
    };

    // ======================== DATA SEED ========================
    function seedData() {
        // Build channels from floor plan
        state.channels = [
            { id: 'all-emergency', name: 'All Emergency', type: 'emergency', icon: 'notifications', members: 0, unread: 0, lastMessage: 'Monitoring all building guests...', lastTime: formatTime(Date.now()) },
            { id: 'unsafe-guests', name: 'Unsafe Guests', type: 'emergency', icon: 'priority_high', members: 0, unread: 0, lastMessage: 'No guests in danger', lastTime: formatTime(Date.now()) },
            { id: 'safe-guests', name: 'Safe Guests', type: 'emergency', icon: 'check_circle', members: 0, unread: 0, lastMessage: 'Waiting for safety reports...', lastTime: formatTime(Date.now()) },
            { id: 'admin-alerts', name: 'Admin Alerts & Requests', type: 'emergency', icon: 'assignment', members: 1, unread: 0, lastMessage: 'No pending requests', lastTime: formatTime(Date.now()) },
        ];


        // Room channels
        Object.entries(FLOOR_PLAN).forEach(([key, floor]) => {
            floor.rooms.forEach(room => {
                state.channels.push({
                    id: `room-${room}`,
                    name: `Room ${room}`,
                    type: 'room',
                    icon: '🚪',
                    members: Math.floor(Math.random() * 3) + 1,
                    unread: 0,
                    lastMessage: 'No alerts',
                    lastTime: formatTime(Date.now()),
                    floor: key
                });
            });
        });

        // Initialize messages for main channels
        const now = Date.now();
        state.messages['all-emergency'] = [
            { id: 'm1', type: 'system', text: '🏥 Emergency Command Messenger — System Online. All floors monitored.', time: now, sender: null }
        ];
        state.messages['admin-alerts'] = [
            { id: 'aa1', type: 'system', text: '📋 Guest requests and reports will appear here.', time: now, sender: null }
        ];
        state.messages['safe-guests'] = [
            { id: 'sg1', type: 'system', text: '✅ Confirmed safe guests will be listed here.', time: now, sender: null }
        ];
        state.messages['unsafe-guests'] = [
            { id: 'ug1', type: 'system', text: 'Guests requiring immediate assistance will appear here.', time: now, sender: null }
        ];

        // Initialize empty messages for all channels
        state.channels.forEach(ch => {
            if (!state.messages[ch.id]) {
                state.messages[ch.id] = [
                    { id: `init-${ch.id}`, type: 'system', text: `Channel "${ch.name}" ready.`, time: now, sender: null }
                ];
            }
        });

        // Rooms grouped by floor
        Object.entries(FLOOR_PLAN).forEach(([key, floor]) => {
            state.rooms[key] = floor.rooms.map(r => ({
                num: r,
                status: 'safe',
                lastUpdate: 'All clear',
                lastUpdateTime: now
            }));
        });

        // Staff
        state.staff = [
            { id: 's1', name: 'Rescue Staff Arjun', initials: 'AR', role: 'Fire Response Lead', status: 'active', color: '#22c55e' },
            { id: 's2', name: 'Nurse Priya', initials: 'PR', role: 'Head Nurse — Floor 2', status: 'active', color: '#f59e0b' },
            { id: 's3', name: 'Dr. Mehta', initials: 'DM', role: 'Emergency Physician', status: 'active', color: '#3b82f6' },
            { id: 's4', name: 'Security Vikram', initials: 'VK', role: 'Security Lead', status: 'active', color: '#8b5cf6' },
            { id: 's5', name: 'Maintenance Raj', initials: 'RJ', role: 'Building Systems', status: 'on-route', color: '#ec4899' },
        ];

        // Alerts
        state.alerts = [
            { id: 'a0', type: 'info', title: 'System Online', desc: 'All 5 floors monitored. 28 rooms connected.', time: now, icon: 'check_circle' }
        ];
    }

    // ======================== DOM REFERENCES ========================
    const DOM = {};
    function cacheDom() {
        DOM.emergencyChannels = document.getElementById('emergency-channels');
        DOM.roomChannels = document.getElementById('room-channels');
        DOM.messagesScroll = document.getElementById('messages-scroll');
        DOM.messagesContainer = document.getElementById('messages-container');
        DOM.messageInput = document.getElementById('message-input');
        DOM.btnSend = document.getElementById('btn-send');
        DOM.btnBroadcast = document.getElementById('btn-open-broadcast');
        DOM.btnResetIncident = document.getElementById('btn-reset-incident');
        DOM.broadcastModal = document.getElementById('broadcast-modal');
        DOM.guestModal = document.getElementById('guest-modal');
        DOM.settingsModal = document.getElementById('settings-modal');
        DOM.newChannelModal = document.getElementById('new-channel-modal');
        DOM.connectionDot = document.getElementById('connection-status-dot');
        DOM.incidentTag = document.getElementById('incident-type-display');
        DOM.incidentTimer = document.getElementById('incident-timer');
        DOM.confirmModal = document.getElementById('confirm-modal');
        DOM.chatChannelName = document.getElementById('chat-channel-name');
        DOM.chatChannelSub = document.getElementById('chat-channel-sub');
        DOM.chatAvatar = document.getElementById('chat-avatar');
        DOM.alertFeed = document.getElementById('alert-feed');
        DOM.staffList = document.getElementById('staff-list');
        DOM.roomGridContainer = document.getElementById('room-grid-container');
        DOM.incidentTimer = document.getElementById('incident-timer');
        DOM.incidentTypeDisplay = document.getElementById('incident-type-display');
        DOM.roomsAlertedCount = document.getElementById('rooms-alerted-count');
        DOM.messageCount = document.getElementById('message-count');
        DOM.sidebarRoomsAlertedCount = document.getElementById('sidebar-rooms-alerted-count');
        DOM.sidebarMessageCount = document.getElementById('sidebar-message-count');
        DOM.sidebarIncidentTimer = document.getElementById('sidebar-incident-timer');
        DOM.sidebarIncidentTag = document.getElementById('sidebar-incident-type-display');
        DOM.sidebarBtnResetIncident = document.getElementById('sidebar-btn-reset-incident');
        DOM.currentSeverityLabel = document.getElementById('current-severity-label');
        DOM.toastContainer = document.getElementById('toast-container');
        DOM.channelSearch = document.getElementById('channel-search');
        DOM.typingIndicator = document.getElementById('typing-indicator');
        DOM.pinnedAlert = document.getElementById('pinned-alert');
        DOM.pinnedAlertText = document.getElementById('pinned-alert-text');
        DOM.sidebarChannels = document.getElementById('sidebar-channels');
        DOM.sidebarAlerts = document.getElementById('sidebar-alerts');
        DOM.quickActions = document.getElementById('quick-actions');
        DOM.aiResult = document.getElementById('ai-result');
        DOM.aiConfidenceFill = document.getElementById('ai-confidence-fill');
        DOM.aiConfidenceValue = document.getElementById('ai-confidence-value');
        DOM.aiSeverityBadge = document.getElementById('ai-severity-badge');
        DOM.aiAnalysisText = document.getElementById('ai-analysis-text');
        DOM.aiRecommendedActions = document.getElementById('ai-recommended-actions');
        DOM.roleDropdown = document.getElementById('role-dropdown');
        DOM.userBadge = document.getElementById('current-user-badge');
        DOM.userAvatarText = document.getElementById('user-avatar-text');
        DOM.userNameText = document.getElementById('user-name-text');
        DOM.webcamVideo = document.getElementById('webcam-video');
        DOM.webcamCanvas = document.getElementById('webcam-canvas');
        DOM.webcamOverlay = document.getElementById('webcam-overlay');
        DOM.detectionBadge = document.getElementById('detection-badge');
        DOM.detectionStatusText = document.getElementById('detection-status-text');
        DOM.logEntries = document.getElementById('log-entries');
        DOM.btnResetIncident = document.getElementById('btn-reset-incident');
        DOM.activeIncidentCard = document.getElementById('active-incident-card');
        DOM.charCount = document.getElementById('char-count');
        // Add these missing DOM references
DOM.btnAttach = document.getElementById('btn-attach');
DOM.btnSettings = document.getElementById('btn-settings');
DOM.btnNewChannel = document.getElementById('btn-new-channel');
DOM.btnClearChat = document.getElementById('btn-clear-chat');
DOM.btnClearAlerts = document.getElementById('btn-clear-alerts');
DOM.btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
DOM.btnToggleAlerts = document.getElementById('btn-toggle-alerts');
DOM.btnClosePinned = document.getElementById('btn-close-pinned');
DOM.sidebarChannels = document.getElementById('sidebar-channels');
DOM.sidebarAlerts = document.getElementById('sidebar-alerts');
DOM.roleDropdown = document.getElementById('role-dropdown');
DOM.userBadge = document.getElementById('user-badge');
DOM.userAvatarText = document.getElementById('user-avatar-text');
DOM.userNameText = document.getElementById('user-name-text');
DOM.charCount = document.getElementById('char-count');
DOM.pinnedAlert = document.getElementById('pinned-alert');
DOM.pinnedAlertText = document.getElementById('pinned-alert-text');

    }

    // ======================== CONFIRM DIALOG ========================
   function showConfirm(title, message, icon, callback) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-icon').textContent = icon || 'warning';
    
    // If callback provided, use old style. If not, return a Promise.
    if (callback) {
        state._confirmCallback = callback;
        showModal('confirm-modal');
        return;
    }
    return new Promise(resolve => {
        state._confirmCallback = () => resolve(true);
        showModal('confirm-modal');
    });
}
    // ======================== ROLE SWITCHING ========================
    function switchRole(role) {
        if (role === 'guest') {
            showModal('guest-modal');
            populateGuestRoomSelect();
            return;
        }

        state.currentRole = 'admin';
        state.assignedRoom = null;
        state.assignedFloor = null;
        state.currentUser = { name: 'Admin', initials: 'AD', role: 'Administrator', id: 'admin-001' };
        
        DOM.userAvatarText.textContent = 'AD';
        DOM.userNameText.textContent = 'Admin';

        // Show/hide admin elements
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
        document.querySelectorAll('.guest-only').forEach(el => el.style.display = 'none');
        DOM.quickActions.style.display = 'none';

        // Update reset button visibility
        updateIncidentUI();

        // Update role dropdown active state
        document.getElementById('role-opt-admin').classList.add('active');
        document.getElementById('role-opt-guest').classList.remove('active');

        selectChannel('all-emergency');
        renderChannels();
        showToast('Admin Mode', 'Full control enabled. All channels visible.', 'info');
    }

    function confirmGuestRole() {
        const name = document.getElementById('guest-name').value.trim() || 'Guest User';
        const floor = document.getElementById('guest-floor').value;
        const room = document.getElementById('guest-room').value;

        if (!room) {
            showToast('Select Room', 'Please select a room.', 'warning');
            return;
        }

        state.currentRole = 'guest';
        state.assignedRoom = room;
        state.assignedFloor = floor;
        const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
        state.currentUser = { name, initials, role: `Room ${room} Guest`, id: `guest-${room}` };

        DOM.userAvatarText.textContent = initials;
        DOM.userNameText.textContent = `Room ${room}`;

        // Hide admin elements, show guest elements
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
        document.querySelectorAll('.guest-only').forEach(el => el.style.display = '');
        DOM.quickActions.style.display = 'flex';

        // Update role dropdown
        document.getElementById('role-opt-admin').classList.remove('active');
        document.getElementById('role-opt-guest').classList.add('active');

        selectChannel(`room-${room}`);
        renderChannels();

        hideModal('guest-modal');
        showToast('Guest Mode', `You are in Room ${room}. You will receive emergency alerts here.`, 'success');
    }

    function populateGuestRoomSelect() {
        const floorSelect = document.getElementById('guest-floor');
        const roomSelect = document.getElementById('guest-room');
        const floorKey = floorSelect.value;
        const rooms = FLOOR_PLAN[floorKey]?.rooms || [];

        roomSelect.innerHTML = '';
        rooms.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r;
            opt.textContent = `Room ${r}`;
            roomSelect.appendChild(opt);
        });
    }

    // ======================== RENDER: CHANNELS ========================
    function renderChannels(filter = '') {
        const filterLower = filter.toLowerCase();
        const groups = {
            emergency: DOM.emergencyChannels,
            room: DOM.roomChannels
        };

        Object.values(groups).forEach(el => el.innerHTML = '');

        state.channels.forEach(ch => {
            // In guest mode, filter channels
            if (state.currentRole === 'guest') {
                const isMyRoom = ch.id === `room-${state.assignedRoom}`;
                const isMyFloor = ch.id === `floor-${state.assignedFloor}`;
                const isEmergency = ch.type === 'emergency';
                if (!isMyRoom && !isMyFloor && !isEmergency) return;
            }

            if (filterLower && !ch.name.toLowerCase().includes(filterLower)) return;
            const li = document.createElement('li');
            li.className = `channel-item${ch.id === state.currentChannelId ? ' active' : ''}${ch.hasAlert ? ' has-alert' : ''}`;
            li.dataset.channelId = ch.id;
            li.innerHTML = `
                <div class="channel-icon"><span class="material-icons-round">${ch.icon.length > 2 ? ch.icon : 'chat'}</span></div>
                <div class="channel-info">
                    <div class="channel-name">
                        <span class="ch-title">${sanitize(ch.name)}</span>
                        ${ch.members > 0 ? `<span class="ch-members-count">${ch.members}</span>` : ''}
                    </div>
                    <div class="channel-preview">${sanitize(ch.lastMessage || '')}</div>
                </div>
                ${ch.unread > 0 ? `<span class="channel-badge">${ch.unread}</span>` : ''}
                <span class="channel-time">${ch.lastTime || ''}</span>
            `;
            li.addEventListener('click', () => selectChannel(ch.id));
            if (ch.type === 'emergency') groups.emergency?.appendChild(li);
            if (ch.type === 'room') groups.room?.appendChild(li);
        });
    }

    // ======================== RENDER: MESSAGES ========================
    function renderMessages() {
        const msgs = state.messages[state.currentChannelId] || [];
        DOM.messagesScroll.innerHTML = '';

        // Add a "ROSTER" section for safe/unsafe groups
        if (state.currentChannelId === 'safe-guests' || state.currentChannelId === 'unsafe-guests') {
    const isSafe = state.currentChannelId === 'safe-guests';
    const relevantGuests = allUsers.filter(u =>
        u.type === 'guest' &&
        (isSafe
            ? u.status === 'safe'
            : (u.status === 'help' || u.status === 'moving'))
    );
            
            if (relevantGuests.length > 0) {
                const roster = document.createElement('div');
                roster.className = 'mission-start-card';
                roster.style.padding = '20px';
                roster.style.marginBottom = '10px';
                roster.innerHTML = `
                <div style="font-size:0.8rem; font-weight:800; color:var(--text-secondary); text-transform:uppercase; margin-bottom:12px; letter-spacing:1px;">
                    Live ${isSafe ? 'Safe' : 'Critical'} Guest Roster — ${relevantGuests.length} ${isSafe ? 'safe' : 'need help'}
                </div>
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap:8px; width:100%;">
                    ${relevantGuests.map(g => `
                        <div style="background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:8px; padding:10px; display:flex; align-items:center; gap:8px;">
                            <div style="width:28px; height:28px; border-radius:50%; background:${isSafe ? '#22c55e' : '#ef4444'}; display:flex; align-items:center; justify-content:center; color:#fff; font-size:11px; font-weight:800; flex-shrink:0;">
                                ${g.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase()}
                            </div>
                            <div style="text-align:left; min-width:0;">
                                <div style="font-size:0.75rem; font-weight:700; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100px;">${sanitize(g.name)}</div>
                                <div style="font-size:0.65rem; color:var(--text-muted);">📍 Node ${sanitize(g.node || '?')}</div>
                                <div style="font-size:0.6rem; color:${isSafe ? '#22c55e' : '#ef4444'}; font-weight:700; text-transform:uppercase;">${g.status}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
                DOM.messagesScroll.appendChild(roster);
            }
        }

        if (msgs.length === 0) {
            const ch = state.channels.find(c => c.id === state.currentChannelId);
            const card = document.createElement('div');
            card.className = 'mission-start-card';
            
            let description = 'This channel is secure and ready for emergency communication.';
            let chips = ['Request Status', 'Send Broadcast'];
            
            if (ch.type === 'room') {
                description = `Direct communication channel for ${ch.name}. Coordinate with occupants and rescue teams assigned to this node.`;
                chips = ['Verify Safe', 'Mark Help', 'Dispatch Team'];
            } else if (ch.id === 'all-emergency') {
                description = 'Global broadcast and system-wide alerts. Every user on the network receives updates from this channel.';
                chips = ['System Summary', 'Crisis Protocols'];
            }

            card.innerHTML = `
                <div class="mission-icon-wrap"><span class="material-icons-round">${ch.icon.length > 2 ? ch.icon : 'chat'}</span></div>
                <h1>${sanitize(ch.name)}</h1>
                <p>${description}</p>
                <div class="mission-actions">
                    ${chips.map(c => `<button class="quick-chip"><span class="material-icons-round" style="font-size:14px">bolt</span> ${c}</button>`).join('')}
                </div>
            `;
            DOM.messagesScroll.appendChild(card);
            scrollToBottom();
            updateStats();
            return;
        }

        const sep = document.createElement('div');
        sep.className = 'date-separator';
        sep.innerHTML = '<span>Today</span>';
        DOM.messagesScroll.appendChild(sep);

        msgs.forEach(msg => {
            DOM.messagesScroll.appendChild(createMessageElement(msg));
        });

        scrollToBottom();
        updateStats();
    }

    function createMessageElement(msg) {
        const el = document.createElement('div');

        if (msg.type === 'system') {
            el.className = 'message system-message';
            el.innerHTML = `
                <div class="msg-content">
                    <div class="msg-bubble">
                        <div class="msg-text">${sanitize(msg.text)}</div>
                    </div>
                    <div class="msg-meta"><span class="msg-time">${formatTime(msg.time)}</span></div>
                </div>
            `;
            return el;
        }

        if (msg.type === 'ai-instruction') {
            el.className = 'message ai-instruction-message';
            el.innerHTML = `
                <div class="msg-content" style="width:100%">
                    <div class="msg-bubble">
                        <div class="ai-msg-header"><span class="material-icons-round">smart_toy</span> AI EMERGENCY INSTRUCTIONS</div>
                        <div class="msg-text ai-instruction-text">${msg.text}</div>
                    </div>
                    <div class="msg-meta">
                        <span class="msg-time">${formatTime(msg.time)} • Gemini AI</span>
                    </div>
                </div>
            `;
            return el;
        }

        if (msg.type === 'broadcast') {
            el.className = `message broadcast-message${msg.severity ? ' severity-' + msg.severity : ''}`;
            el.innerHTML = `
                <div class="msg-content" style="width:100%">
                    <div class="msg-bubble">
                        <div class="broadcast-header"><span class="material-icons-round">campaign</span> ${msg.broadcastType || 'EMERGENCY BROADCAST'}</div>
                        <div class="msg-text">${sanitize(msg.text)}</div>
                    </div>
                    <div class="msg-meta">
                        <span class="msg-time">${formatTime(msg.time)} • Sent by ${sanitize(msg.sender?.name || 'System')}</span>
                    </div>
                </div>
            `;
            return el;
        }

        if (msg.type === 'guest-request') {
            el.className = 'message guest-request-message';
            el.innerHTML = `
                <div class="msg-avatar" style="background:linear-gradient(135deg,#f59e0b,#ef4444)">${sanitize(msg.sender?.initials || 'GU')}</div>
                <div class="msg-content">
                    <div class="msg-bubble">
                        <div class="guest-req-header"><span class="material-icons-round">${msg.reqIcon || 'help'}</span> ${sanitize(msg.reqType || 'GUEST REQUEST')}</div>
                        <div class="msg-sender">${sanitize(msg.sender?.name || 'Guest')} • Room ${sanitize(msg.roomNum || '?')}</div>
                        <div class="msg-text">${sanitize(msg.text)}</div>
                    </div>
                    <div class="msg-meta"><span class="msg-time">${formatTime(msg.time)}</span></div>
                </div>
            `;
            return el;
        }

        const isOutgoing = msg.type === 'outgoing';
        el.className = `message ${msg.type}${msg.severity && msg.severity !== 'normal' ? ' severity-' + msg.severity : ''}`;

        const avatarColor = isOutgoing
            ? 'background:linear-gradient(135deg,#22c55e,#16a34a)'
            : `background:linear-gradient(135deg,${getAvatarColor(msg.sender?.initials || 'UN')})`;

        const avatarHtml = state.settings.showAvatars
            ? `<div class="msg-avatar" style="${avatarColor}">${sanitize(msg.sender?.initials || 'UN')}</div>`
            : '';

        el.innerHTML = `
            ${avatarHtml}
            <div class="msg-content">
                <div class="msg-bubble">
                    <div class="msg-sender">${sanitize(msg.sender?.name || 'Unknown')}${msg.sender?.role ? ' • ' + sanitize(msg.sender.role) : ''}</div>
                    <div class="msg-text">${sanitize(msg.text)}</div>
                </div>
                <div class="msg-meta">
                    <span class="msg-time">${formatTime(msg.time)}</span>
                    ${isOutgoing ? '<span class="msg-status material-icons-round">done_all</span>' : ''}
                </div>
            </div>
        `;
        return el;
    }

    // ======================== RENDER: ALERTS ========================
    function renderAlerts() {
        DOM.alertFeed.innerHTML = '';

        if (state.alerts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state-small';
            empty.innerHTML = `<span class="material-icons-round">notifications_none</span><p>No alerts</p>`;
            DOM.alertFeed.appendChild(empty);
            return;
        }

        state.alerts.sort((a, b) => b.time - a.time).forEach(alert => {
            const el = document.createElement('div');
            el.className = `alert-item alert-${alert.type}`;
            el.innerHTML = `
                <div class="alert-icon"><span class="material-icons-round">${alert.icon || 'warning'}</span></div>
                <div class="alert-content">
                    <div class="alert-title">${sanitize(alert.title)}</div>
                    <div class="alert-desc">${sanitize(alert.desc)}</div>
                </div>
                <span class="alert-time">${formatTime(alert.time)}</span>
            `;
            DOM.alertFeed.appendChild(el);
        });
    }

    // ======================== RENDER: STAFF ========================
    function renderStaff() {
        DOM.staffList.innerHTML = '';
        
        const rescueTeam = state.staff.filter(s => s.role === 'Rescue Team');
        const evacTeam = state.staff.filter(s => s.role === 'Evacuation Team');

        const createStaffHTML = (s) => `
            <div class="staff-item">
                <div class="staff-avatar" style="background:${s.color}">${s.initials}</div>
                <div class="staff-info">
                    <div class="staff-name">
                        ${sanitize(s.name)}
                        <span class="staff-location">@ ${s.node}</span>
                    </div>
                    <div class="staff-role">${sanitize(s.role)}</div>
                </div>
                <span class="staff-status-badge ${s.status}">${s.status === 'on-route' ? 'ON ROUTE' : s.status.toUpperCase()}</span>
            </div>
        `;

        if (rescueTeam.length > 0) {
            const header = document.createElement('div');
            header.className = 'staff-category-header';
            header.innerHTML = '<span class="material-icons-round">medical_services</span> RESCUE TEAM';
            DOM.staffList.appendChild(header);
            rescueTeam.forEach(s => {
                const div = document.createElement('div');
                div.innerHTML = createStaffHTML(s);
                DOM.staffList.appendChild(div.firstElementChild);
            });
        }

        if (evacTeam.length > 0) {
            const header = document.createElement('div');
            header.className = 'staff-category-header';
            header.innerHTML = '<span class="material-icons-round">directions_run</span> EVACUATION TEAM';
            DOM.staffList.appendChild(header);
            evacTeam.forEach(s => {
                const div = document.createElement('div');
                div.innerHTML = createStaffHTML(s);
                DOM.staffList.appendChild(div.firstElementChild);
            });
        }

        if (state.staff.length === 0) {
            DOM.staffList.innerHTML = '<div class="empty-state-small"><p>No staff online</p></div>';
        }
    }

    // ======================== RENDER: ROOM GRID (BY FLOOR) ========================
    function renderRoomGrid() {
        DOM.roomGridContainer.innerHTML = '';

        Object.entries(FLOOR_PLAN).forEach(([floorKey, floor]) => {
            const section = document.createElement('div');
            section.className = 'floor-grid-group';

            const header = document.createElement('div');
            header.className = 'floor-grid-header';
            header.textContent = floor.shortName;
            section.appendChild(header);

            const grid = document.createElement('div');
            grid.className = 'room-grid';

            const rooms = state.rooms[floorKey] || [];
            rooms.forEach(r => {
                const tile = document.createElement('div');
                tile.className = `room-tile ${r.status}`;
                const statusIcon = r.status === 'help' ? 'priority_high' : (r.status === 'safe' ? 'check_circle' : 'meeting_room');
                const occupantName = r.lastUpdate.includes(':') ? r.lastUpdate.split(':')[0] : '';

                tile.innerHTML = `
                    <span class="room-num">${r.num}</span>
                    ${occupantName ? `<span class="room-occupant-name">${occupantName}</span>` : ''}
                    <span class="room-status-icon"><span class="material-icons-round">${r.status === 'help' ? 'priority_high' : (r.status === 'safe' ? 'check_circle' : 'meeting_room')}</span></span>
                `;
                tile.title = `Room ${r.num} — ${r.status.toUpperCase()}\n${r.lastUpdate}`;
                tile.addEventListener('click', () => selectChannel(`room-${r.num}`));
                grid.appendChild(tile);
            });

            section.appendChild(grid);
            DOM.roomGridContainer.appendChild(section);
        });
    }

    // ======================== DYNAMIC ROOM STATUS ========================
    function updateRoomStatus(roomNum, newStatus, updateText) {
        for (const [floorKey, rooms] of Object.entries(state.rooms)) {
            const room = rooms.find(r => r.num === roomNum);
            if (room) {
                room.status = newStatus;
                room.lastUpdate = updateText || `Status: ${newStatus}`;
                room.lastUpdateTime = Date.now();
                break;
            }
        }
        renderRoomGrid();
        updateStats();
    }

    function updateFloorRoomStatus(floorKey, newStatus, updateText) {
        const rooms = state.rooms[floorKey];
        if (!rooms) return;
        rooms.forEach(r => {
            r.status = newStatus;
            r.lastUpdate = updateText || `Floor-wide: ${newStatus}`;
            r.lastUpdateTime = Date.now();
        });

        // Mark floor channel as having alert
        const floorChannel = state.channels.find(c => c.id === `floor-${floorKey}`);
        if (floorChannel && (newStatus === 'alert' || newStatus === 'warning')) {
            floorChannel.hasAlert = true;
        }

        // Mark room channels
        const floorRooms = FLOOR_PLAN[floorKey]?.rooms || [];
        floorRooms.forEach(roomNum => {
            const roomChannel = state.channels.find(c => c.id === `room-${roomNum}`);
            if (roomChannel && (newStatus === 'alert' || newStatus === 'warning')) {
                roomChannel.hasAlert = true;
            }
        });

        renderRoomGrid();
        renderChannels();
        updateStats();
    }

    // Evaluate messages to auto-update room status
    function evaluateRoomStatusFromMessage(text, channelId) {
        const lowerText = text.toLowerCase();

        const roomMatch = channelId.match(/^room-(.+)$/);
        if (roomMatch) {
            const roomNum = roomMatch[1];
            if (lowerText.includes('safe') || lowerText.includes('clear') || lowerText.includes('all clear') || lowerText.includes("i'm safe")) {
                updateRoomStatus(roomNum, 'safe', text.substring(0, 60));
            } else if (lowerText.includes('evacuated') || lowerText.includes('evacuating')) {
                updateRoomStatus(roomNum, 'evacuated', text.substring(0, 60));
            } else if (lowerText.includes('fire') || lowerText.includes('smoke') || lowerText.includes('danger') || lowerText.includes('critical') || lowerText.includes('help') || lowerText.includes('sos') || lowerText.includes('emergency')) {
                updateRoomStatus(roomNum, 'alert', text.substring(0, 60));
            } else if (lowerText.includes('warning') || lowerText.includes('caution') || lowerText.includes('attention')) {
                updateRoomStatus(roomNum, 'warning', text.substring(0, 60));
            }
        }
    }

    // ======================== INCIDENT MANAGEMENT ========================
    function resetIncident() {
        state.incidentActive = false;
        state.incidentStartTime = null;
        state.incidentType = null;
        state.incidentFloor = null;

        DOM.incidentTypeDisplay.textContent = 'No Active Incident';
        DOM.incidentTimer.textContent = '00:00:00';
        DOM.pinnedAlert.style.display = 'none';

        // Reset all room statuses
        Object.entries(FLOOR_PLAN).forEach(([key]) => {
            const rooms = state.rooms[key];
            if (rooms) {
                rooms.forEach(r => {
                    r.status = 'safe';
                    r.lastUpdate = 'All clear';
                    r.lastUpdateTime = Date.now();
                });
            }
        });

        // Clear channel alert states
        state.channels.forEach(ch => {
            ch.hasAlert = false;
        });

        updateIncidentUI();
        renderRoomGrid();
        renderChannels();
        updateStats();

        // Add system message
        const sysMsg = {
            id: 'sys-reset-' + Date.now(),
            type: 'system',
            text: '✅ Incident has been cleared. All rooms reset to safe status.',
            time: Date.now(),
            sender: null
        };
        if (!state.messages['all-emergency']) state.messages['all-emergency'] = [];
        state.messages['all-emergency'].push(sysMsg);
        if (state.currentChannelId === 'all-emergency') renderMessages();

        showToast('Incident Cleared', 'All rooms reset to safe. Incident timer stopped.', 'success');
    }

    function updateIncidentUI() {
        if (DOM.btnResetIncident) {
            DOM.btnResetIncident.style.display = (state.incidentActive && state.currentRole === 'admin') ? 'flex' : 'none';
        }
        const card = document.getElementById('active-incident-card');
        if (card) {
            card.classList.toggle('active', state.incidentActive);
        }
    }

    // ======================== CHANNEL SELECT ========================
    function selectChannel(channelId) {
        state.currentChannelId = channelId;
        const ch = state.channels.find(c => c.id === channelId);
        if (!ch) return;

        ch.unread = 0;

        DOM.chatChannelName.textContent = ch.name;
        DOM.chatChannelSub.textContent = `${ch.members} member${ch.members !== 1 ? 's' : ''}`;
        DOM.chatAvatar.textContent = ch.icon;

        renderChannels();
        renderMessages();
        emit('channelChange', { channelId, channel: ch });
        DOM.sidebarChannels.classList.remove('open');

        // Focus input
        DOM.messageInput.focus();
    }

    // ======================== SEND MESSAGE ========================
    async function sendMessage(text, severity = 'normal', channelId = null) {
        const chId = channelId || state.currentChannelId;
        const userInput = text || DOM.messageInput.value;
        if (!userInput || !userInput.trim()) return;

        const msg = {
            id: 'm-' + Date.now(),
            type: 'outgoing',
            text: userInput.trim(),
            time: Date.now(),
            sender: { ...state.currentUser },
            severity: severity
        };

        if (!state.messages[chId]) state.messages[chId] = [];
        state.messages[chId].push(msg);

        const ch = state.channels.find(c => c.id === chId);
        if (ch) {
            ch.lastMessage = msg.text.substring(0, 60);
            ch.lastTime = formatTime(msg.time);
        }

        if (chId === state.currentChannelId) {
            DOM.messagesScroll.appendChild(createMessageElement(msg));
            scrollToBottom();
        }

        // Clear input if sending from main input
        if (!text && DOM.messageInput) {
            DOM.messageInput.value = '';
            DOM.messageInput.style.height = 'auto';
            updateSendButton();
        }

        renderChannels();
        updateStats();

        // Persist to backend logs
        apiPost('/api/log', { 
            message: `[CHAT][${chId.toUpperCase()}] ${state.currentUser.name}: ${msg.text}`,
            timestamp: new Date()
        }).catch(err => console.error('[MSG LOG ERROR]', err));

        return msg;
    }

    // ======================== GUEST QUICK ACTIONS ========================
    function handleQuickAction(action) {
        if (state.currentRole !== 'guest' || !state.assignedRoom) return;

        const roomChannelId = `room-${state.assignedRoom}`;
        const adminChannelId = 'admin-alerts';
        let text = '';
        let severity = 'normal';
        let reqType = '';
        let reqIcon = 'help';

        switch (action) {
            case 'sos':
                text = `EMERGENCY: I need immediate help! Room ${state.assignedRoom}.`;
                severity = 'critical';
                reqType = 'SOS — HELP NEEDED';
                reqIcon = 'emergency';
                break;
            case 'safe':
                text = `I'm safe in Room ${state.assignedRoom}. No injuries.`;
                severity = 'info';
                reqType = 'SAFE REPORT';
                reqIcon = 'check_circle';
                break;
            case 'medical':
                text = `Medical assistance needed in Room ${state.assignedRoom}. Please send help.`;
                severity = 'warning';
                reqType = 'MEDICAL REQUEST';
                reqIcon = 'local_hospital';
                break;
            case 'report':
                text = `Situation Report from Room ${state.assignedRoom}: ` + (DOM.messageInput.value.trim() || 'Situation update from room.');
                severity = 'info';
                reqType = 'SITUATION REPORT';
                reqIcon = 'info';
                break;
        }

        // Send to room channel as outgoing
        sendMessage(text, severity, roomChannelId);

        // Also send as guest request to admin alerts
        const guestReq = {
            id: 'greq-' + Date.now(),
            type: 'guest-request',
            text: text,
            time: Date.now(),
            sender: { ...state.currentUser },
            severity: severity,
            reqType: reqType,
            reqIcon: reqIcon,
            roomNum: state.assignedRoom
        };

        if (!state.messages[adminChannelId]) state.messages[adminChannelId] = [];
        state.messages[adminChannelId].push(guestReq);

        // Update admin alerts channel
        const adminCh = state.channels.find(c => c.id === adminChannelId);
        if (adminCh) {
            adminCh.unread = (adminCh.unread || 0) + 1;
            adminCh.lastMessage = `Room ${state.assignedRoom}: ${action.toUpperCase()}`;
            adminCh.lastTime = formatTime(Date.now());
            adminCh.hasAlert = severity === 'critical';
        }

        // Add to alerts
        state.alerts.unshift({
            id: 'g-alert-' + Date.now(),
            type: severity === 'critical' ? 'critical' : severity === 'warning' ? 'warning' : 'info',
            title: `Room ${state.assignedRoom} — ${reqType}`,
            desc: text,
            time: Date.now(),
            icon: reqIcon
        });

        renderChannels();
        renderAlerts();
        DOM.messageInput.value = '';
        updateSendButton();
        showToast('Message Sent', `Your ${action} report has been sent to Admin.`, 'success');
    }

    // ======================== BROADCAST ========================
    function broadcastAlert(severity, incidentType, floorKey, message) {
        const floorName = floorKey === 'all' ? 'All Floors' : (FLOOR_PLAN[floorKey]?.name || `Floor ${floorKey}`);
        const fullText = `EMERGENCY BROADCAST: ${incidentType.toUpperCase()} — ${floorName}. ${message}`;

        // Activate incident
        state.incidentActive = true;
        state.incidentStartTime = Date.now();
        state.incidentType = incidentType;
        state.incidentFloor = floorKey;
        DOM.incidentTypeDisplay.textContent = `${incidentType.charAt(0).toUpperCase() + incidentType.slice(1)} — ${floorName}`;
        updateIncidentUI();

        // Trigger real incident on backend if it's fire
        if (incidentType === 'fire') {
            apiPost('/api/fire', { node: floorKey === 'all' ? '1' : floorKey });
        }

        // Show pinned alert
        DOM.pinnedAlert.style.display = 'flex';
        DOM.pinnedAlertText.textContent = `CRITICAL ALERT: ${incidentType.charAt(0).toUpperCase() + incidentType.slice(1)} detected on ${floorName} — All personnel respond immediately`;

        const broadcastMsg = {
            id: 'bc-' + Date.now(),
            type: 'broadcast',
            text: fullText,
            time: Date.now(),
            sender: { ...state.currentUser },
            severity: severity,
            broadcastType: `${severity.toUpperCase()} — ${incidentType.toUpperCase()}`
        };

        // Determine target channels
        const targetChannels = state.channels.filter(ch => {
            if (floorKey === 'all') return true;
            if (ch.type === 'emergency') return true;
            if (ch.id === `floor-${floorKey}`) return true;
            if (ch.type === 'room' && ch.floor === floorKey) return true;
            return false;
        });

        targetChannels.forEach(ch => {
            if (!state.messages[ch.id]) state.messages[ch.id] = [];
            state.messages[ch.id].push({ ...broadcastMsg, id: broadcastMsg.id + '-' + ch.id });
            ch.lastMessage = '🚨 BROADCAST: ' + message.substring(0, 40);
            ch.lastTime = formatTime(broadcastMsg.time);
            if (ch.id !== state.currentChannelId) {
                ch.unread = (ch.unread || 0) + 1;
            }
        });

        // Update room statuses
        if (floorKey === 'all') {
            Object.keys(FLOOR_PLAN).forEach(fk => updateFloorRoomStatus(fk, 'alert', `${incidentType} alert — take action`));
        } else {
            updateFloorRoomStatus(floorKey, 'alert', `${incidentType} detected — evacuate`);
        }

        // Add alert
        state.alerts.unshift({
            id: 'alert-bc-' + Date.now(),
            type: severity === 'evacuation' ? 'critical' : severity,
            title: `${emoji} ${incidentType.toUpperCase()} — ${floorName}`,
            desc: message,
            time: Date.now(),
            icon: 'campaign'
        });

        renderMessages();
        renderChannels();
        renderAlerts();
        updateStats();

        showToast('🚨 Broadcast Sent', `Alert sent to ${targetChannels.length} channels on ${floorName}`, 'success');
        emit('broadcast', broadcastMsg);

        return broadcastMsg;
    }

    // ======================== AI EMERGENCY INSTRUCTIONS (GEMINI) ========================
    async function generateEmergencyInstructions(incidentType, floorKey) {
        const floorName = FLOOR_PLAN[floorKey]?.name || `Floor ${floorKey}`;
        const rooms = FLOOR_PLAN[floorKey]?.rooms || [];

        const apiKey = state.geminiApiKey || document.getElementById('settings-api-key')?.value;

        let instructions;

        if (apiKey && apiKey.trim() !== '') {
            state.geminiApiKey = apiKey.trim();
            try {
                const prompt = `You are an emergency AI assistant for a hospital disaster management system. A ${incidentType.toUpperCase()} emergency has been detected on "${floorName}" of the hospital.

Generate clear, urgent emergency instructions for room occupants. Format your response EXACTLY as follows (plain text, no markdown):

🚨 EMERGENCY: ${incidentType.toUpperCase()} DETECTED on ${floorName}

✅ WHAT TO DO:
1. [instruction]
2. [instruction]
3. [instruction]
4. [instruction]
5. [instruction]

❌ WHAT NOT TO DO:
1. [instruction]
2. [instruction]
3. [instruction]
4. [instruction]

📞 EMERGENCY CONTACTS:
• Admin Control Room: Extension 100
• Fire Department: 101
• Medical Emergency: 102

Stay calm. Help is on the way.

Make instructions specific to ${incidentType} in a hospital setting. Keep each instruction to one line. Be direct and urgent.`;

                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey.trim()}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.4, maxOutputTokens: 800 }
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    instructions = data.candidates?.[0]?.content?.parts?.[0]?.text;
                }
            } catch (err) {
                console.error('Gemini instruction error:', err);
            }
        }

        // Fallback instructions
        if (!instructions) {
            instructions = getFallbackInstructions(incidentType, floorName);
        }

        // Send AI instruction message to all rooms on the floor
        rooms.forEach(roomNum => {
            const chId = `room-${roomNum}`;
            if (!state.messages[chId]) state.messages[chId] = [];
            state.messages[chId].push({
                id: 'ai-inst-' + Date.now() + '-' + roomNum,
                type: 'ai-instruction',
                text: instructions,
                time: Date.now(),
                sender: { name: 'Gemini AI', initials: 'AI', role: 'Emergency AI' }
            });

            const ch = state.channels.find(c => c.id === chId);
            if (ch) {
                ch.lastMessage = '🤖 AI Instructions sent';
                ch.lastTime = formatTime(Date.now());
                if (ch.id !== state.currentChannelId) ch.unread = (ch.unread || 0) + 1;
            }
        });

        // Also send to the floor channel
        const floorChId = `floor-${floorKey}`;
        if (!state.messages[floorChId]) state.messages[floorChId] = [];
        state.messages[floorChId].push({
            id: 'ai-inst-floor-' + Date.now(),
            type: 'ai-instruction',
            text: instructions,
            time: Date.now(),
            sender: { name: 'Gemini AI', initials: 'AI', role: 'Emergency AI' }
        });

        // Also to all-emergency
        if (!state.messages['all-emergency']) state.messages['all-emergency'] = [];
        state.messages['all-emergency'].push({
            id: 'ai-inst-all-' + Date.now(),
            type: 'ai-instruction',
            text: instructions,
            time: Date.now(),
            sender: { name: 'Gemini AI', initials: 'AI', role: 'Emergency AI' }
        });

        renderMessages();
        renderChannels();
        showToast('🤖 AI Instructions Generated', `Emergency DOs & DON\'Ts sent to ${rooms.length} rooms on ${floorName}`, 'success');
    }

    function getFallbackInstructions(incidentType, floorName) {
        const instructions = {
            fire: `EMERGENCY: FIRE DETECTED on ${floorName}

WHAT TO DO:
1. Stay low to avoid smoke inhalation — crawl if necessary
2. Cover your nose and mouth with a wet cloth
3. Move toward the nearest emergency exit (use stairs ONLY)
4. Feel doors before opening — if hot, use alternate route
5. Alert others as you evacuate — check on nearby rooms
6. Proceed to the assembly point (Conference Hall, Ground Floor)

WHAT NOT TO DO:
1. DO NOT use elevators under any circumstances
2. DO NOT open windows if smoke is outside
3. DO NOT go back for personal belongings
4. DO NOT panic — stay calm and follow instructions
5. DO NOT block emergency exits or stairways

EMERGENCY CONTACTS:
• Admin Control Room: Extension 100
• Fire Department: 101
• Medical Emergency: 102

Stay calm. Help is on the way. Rescue team has been dispatched.`,

            earthquake: `EMERGENCY: EARTHQUAKE DETECTED on ${floorName}

WHAT TO DO:
1. DROP, COVER, and HOLD ON immediately
2. Get under a sturdy desk or table
3. Stay away from windows, mirrors, and heavy furniture
4. Protect your head and neck with your arms
5. After shaking stops, evacuate using stairs only
6. Move to open area away from buildings

WHAT NOT TO DO:
1. DO NOT run outside during shaking
2. DO NOT use elevators
3. DO NOT stand near windows or glass partitions
4. DO NOT light matches or candles (gas leak risk)

EMERGENCY CONTACTS:
• Admin Control Room: Extension 100
• Emergency Services: 112

Stay calm. Aftershocks may follow.`,

            gas_leak: `EMERGENCY: GAS LEAK DETECTED on ${floorName}

WHAT TO DO:
1. Leave the area immediately — move upwind
2. Cover your nose and mouth with a wet cloth
3. Open windows as you leave (if safe to do so)
4. Move to the assembly point outdoors
5. Report any unusual smells to admin immediately

WHAT NOT TO DO:
1. DO NOT turn on/off any electrical switches
2. DO NOT use your phone near the leak area
3. DO NOT light any flames or matches
4. DO NOT use elevators

EMERGENCY CONTACTS:
• Admin Control Room: Extension 100
• Gas Emergency: 1906

Evacuate calmly. Ventilation team is responding.`,

            flood: `EMERGENCY: FLOOD ALERT on ${floorName}

WHAT TO DO:
1. Move to higher floors immediately
2. Unplug all electrical equipment
3. Avoid walking through moving water
4. Help immobile patients to safety first
5. Follow staff instructions for evacuation routes

WHAT NOT TO DO:
1. DO NOT touch electrical equipment in water
2. DO NOT use elevators
3. DO NOT walk through flooded areas alone
4. DO NOT ignore rising water levels

EMERGENCY CONTACTS:
• Admin Control Room: Extension 100
• Flood Control: 1070

Move to higher ground. Emergency team notified.`
        };

        return instructions[incidentType] || instructions.fire;
    }

    // ======================== AI VERIFICATION (GEMINI) ========================
    async function verifyWithAI(report, source) {
        const apiKey = state.geminiApiKey || document.getElementById('settings-api-key')?.value;

        if (!apiKey || apiKey.trim() === '') {
            showToast('API Key Required', 'Please set your Gemini API key in Settings to use AI verification.', 'warning');
            return null;
        }

        state.geminiApiKey = apiKey.trim();

        const prompt = `You are an AI assistant for a hospital emergency management system. Analyze this incident report for credibility and provide actionable recommendations.

INCIDENT REPORT:
"${report}"

SOURCE: ${source}

Respond in this exact JSON format:
{
  "credibility_score": <number 0-100>,
  "severity": "<low|medium|high|critical>",
  "analysis": "<your detailed analysis>",
  "recommended_actions": ["<action 1>", "<action 2>", "<action 3>"],
  "is_likely_real": <true|false>,
  "risk_assessment": "<brief risk summary>"
}`;

        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey.trim()}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.3, maxOutputTokens: 1024, responseMimeType: 'application/json' }
                })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData?.error?.message || `API Error: ${response.status}`);
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Empty response from Gemini');
            return JSON.parse(text);
        } catch (err) {
            console.error('Gemini API error:', err);
            showToast('AI Error', err.message || 'Failed to contact Gemini API.', 'error');
            return null;
        }
    }

    // ======================== WEBCAM FIRE DETECTION ========================
    async function startWebcamDetection() {
        const floorKey = document.getElementById('webcam-floor').value;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 640, height: 480 } });
            state.webcamStream = stream;
            DOM.webcamVideo.srcObject = stream;
            DOM.webcamOverlay.style.display = 'none';
            DOM.detectionBadge.style.display = 'flex';
            DOM.detectionStatusText.textContent = 'SCANNING...';
            DOM.detectionBadge.className = 'detection-badge scanning';

            document.getElementById('btn-start-detect').disabled = true;
            document.getElementById('btn-stop-detect').disabled = false;

            addDetectionLog('Camera activated. Starting fire detection...', 'info');
            state.detectionActive = true;

            // Start detection loop
            state.webcamInterval = setInterval(() => {
                captureAndAnalyze(floorKey);
            }, 3500);

        } catch (err) {
            console.error('Webcam access failed:', err);
            showToast('Camera Error', 'Could not access webcam. Please allow camera permissions.', 'error');
            addDetectionLog('❌ Camera access denied: ' + err.message, 'error');
        }
    }

    function stopWebcamDetection() {
        state.detectionActive = false;
        if (state.webcamInterval) {
            clearInterval(state.webcamInterval);
            state.webcamInterval = null;
        }
        if (state.webcamStream) {
            state.webcamStream.getTracks().forEach(t => t.stop());
            state.webcamStream = null;
        }
        DOM.webcamVideo.srcObject = null;
        DOM.webcamOverlay.style.display = 'flex';
        DOM.detectionBadge.style.display = 'none';

        document.getElementById('btn-start-detect').disabled = false;
        document.getElementById('btn-stop-detect').disabled = true;

        addDetectionLog('⏹️ Detection stopped.', 'info');
    }

    async function captureAndAnalyze(floorKey) {
        if (!state.detectionActive) return;

        const video = DOM.webcamVideo;
        const canvas = DOM.webcamCanvas;
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);

        const base64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
        const apiKey = state.geminiApiKey || document.getElementById('settings-api-key')?.value;

        if (apiKey && apiKey.trim() !== '') {
            state.geminiApiKey = apiKey.trim();
            try {
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey.trim()}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: 'Analyze this camera image. Is there any fire, flame, or smoke visible? Respond in JSON: {"fire_detected": true/false, "confidence": 0-100, "description": "brief description of what you see"}' },
                                { inlineData: { mimeType: 'image/jpeg', data: base64 } }
                            ]
                        }],
                        generationConfig: { temperature: 0.1, maxOutputTokens: 256, responseMimeType: 'application/json' }
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (text) {
                        const result = JSON.parse(text);
                        handleDetectionResult(result, floorKey);
                        return;
                    }
                }
            } catch (err) {
                console.error('Gemini vision error:', err);
            }
        }

        // Fallback: Simple color-based heuristic
        const heuristicResult = analyzeFrameHeuristic(ctx, canvas.width, canvas.height);
        handleDetectionResult(heuristicResult, floorKey);
    }

    function analyzeFrameHeuristic(ctx, w, h) {
        const imageData = ctx.getImageData(0, 0, w, h);
        const pixels = imageData.data;
        let firePixels = 0;
        const totalPixels = w * h;

        for (let i = 0; i < pixels.length; i += 16) {
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            if (r > 180 && g > 60 && g < 180 && b < 80 && r > g * 1.3) {
                firePixels++;
            }
        }

        const fireRatio = firePixels / (totalPixels / 4);
        const confidence = Math.min(95, Math.round(fireRatio * 500));
        const detected = confidence > 30;

        return {
            fire_detected: detected,
            confidence: detected ? confidence : Math.round(fireRatio * 100),
            description: detected ? `Fire-colored pixels detected (${(fireRatio * 100).toFixed(1)}% of frame).` : 'No significant fire indicators in frame.'
        };
    }

    function handleDetectionResult(result, floorKey) {
        if (!state.detectionActive) return;

        const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

        if (result.fire_detected && result.confidence > 40) {
            DOM.detectionStatusText.textContent = `🔥 FIRE DETECTED (${result.confidence}%)`;
            DOM.detectionBadge.className = 'detection-badge fire-detected';
            addDetectionLog(`🔥 [${time}] FIRE DETECTED — Confidence: ${result.confidence}% — ${result.description}`, 'critical');

            // Only trigger alert once per detection session
            if (!state._fireAlertTriggered) {
                state._fireAlertTriggered = true;

                showToast('🔥 FIRE DETECTED', `Fire detected on ${FLOOR_PLAN[floorKey]?.name}! Triggering emergency protocol...`, 'error');

                setTimeout(() => {
                    broadcastAlert('critical', 'fire', floorKey, `Fire/smoke detected by camera system on ${FLOOR_PLAN[floorKey]?.name}. Confidence: ${result.confidence}%. Automated emergency protocol activated.`);
                }, 1000);

                setTimeout(() => {
                    generateEmergencyInstructions('fire', floorKey);
                }, 3000);
            }
        } else {
            DOM.detectionStatusText.textContent = 'SCANNING...';
            DOM.detectionBadge.className = 'detection-badge scanning';
            addDetectionLog(`✅ [${time}] All clear — ${result.description || 'No fire detected'}`, 'info');
        }
    }

    function addDetectionLog(text, type) {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        entry.textContent = text;
        DOM.logEntries.appendChild(entry);
        DOM.logEntries.scrollTop = DOM.logEntries.scrollHeight;
    }

    // ======================== EVENT SYSTEM ========================
    function on(event, callback) {
        if (state.eventListeners[event]) state.eventListeners[event].push(callback);
    }

    function emit(event, data) {
        (state.eventListeners[event] || []).forEach(cb => {
            try { cb(data); } catch (e) { console.error('Event listener error:', e); }
        });
    }

    // ======================== TOAST NOTIFICATIONS ========================
    function showToast(title, desc, type = 'info') {
        const toast = document.createElement('div');
        toast.className = 'toast';
        const icons = { success: 'check_circle', error: 'error', warning: 'warning', info: 'info' };
        toast.innerHTML = `
            <span class="toast-icon toast-${type} material-icons-round">${icons[type] || 'info'}</span>
            <div class="toast-body">
                <div class="toast-title">${sanitize(title)}</div>
                <div class="toast-desc">${sanitize(desc)}</div>
            </div>
            <button class="toast-close" onclick="this.parentElement.classList.add('toast-out');setTimeout(()=>this.parentElement.remove(),300)">
                <span class="material-icons-round" style="font-size:18px">close</span>
            </button>
        `;
        DOM.toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('toast-out');
            setTimeout(() => toast.remove(), 300);
        }, 5000);
    }

    // ======================== UTILS ========================
    function sanitize(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatTime(ts) {
        const d = new Date(ts);
        return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;
        });
    }

    function getAvatarColor(initials) {
        const colors = ['#6366f1,#a855f7', '#3b82f6,#06b6d4', '#ec4899,#f43f5e', '#f59e0b,#ef4444', '#8b5cf6,#6366f1', '#14b8a6,#22c55e'];
        const idx = (initials.charCodeAt(0) + (initials.charCodeAt(1) || 0)) % colors.length;
        return colors[idx];
    }

    function getIncidentEmoji(type) {
        const map = { fire: '🔥', earthquake: '🌍', flood: '🌊', gas_leak: '☁️', structural: '🏗️', medical: '🏥', security: '🔒', other: '📋' };
        return map[type] || '⚠️';
    }

    function updateStats() {
        const totalMsgs = Object.values(state.messages).reduce((sum, arr) => sum + arr.length, 0);
        if (DOM.messageCount) DOM.messageCount.textContent = totalMsgs;
        if (DOM.sidebarMessageCount) DOM.sidebarMessageCount.textContent = totalMsgs;

        let totalRooms = 0;
        let alertedRooms = 0;
        Object.values(state.rooms).forEach(rooms => {
            rooms.forEach(r => {
                totalRooms++;
                // Status mapping: help/moving/alert (fire) count as alerted
                const fireAtNode = state.incidentActive && state.fireNodes && state.fireNodes.includes(r.num);
                if (r.status === 'help' || r.status === 'moving' || r.status === 'alert' || fireAtNode) alertedRooms++;
            });
        });
        const statText = `${alertedRooms} / ${totalRooms}`;
        if (DOM.roomsAlertedCount) DOM.roomsAlertedCount.textContent = statText;
        if (DOM.sidebarRoomsAlertedCount) DOM.sidebarRoomsAlertedCount.textContent = statText;
    }

    function updateSendButton() {
        const hasText = DOM.messageInput.value.trim().length > 0;
        DOM.btnSend.disabled = !hasText;
        DOM.btnSend.classList.toggle('active', hasText);
    }

    // ======================== INCIDENT TIMER ========================
    function startIncidentTimer() {
        setInterval(() => {
            if (!state.incidentActive || !state.incidentStartTime) {
                if (DOM.incidentTimer) DOM.incidentTimer.textContent = '00:00:00';
                if (DOM.sidebarIncidentTimer) DOM.sidebarIncidentTimer.textContent = '00:00:00';
                return;
            }
            const elapsed = Date.now() - state.incidentStartTime;
            const hrs = Math.floor(elapsed / 3600000).toString().padStart(2, '0');
            const mins = Math.floor((elapsed % 3600000) / 60000).toString().padStart(2, '0');
            const secs = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');
            const timerText = `${hrs}:${mins}:${secs}`;
            if (DOM.incidentTimer) DOM.incidentTimer.textContent = timerText;
            if (DOM.sidebarIncidentTimer) DOM.sidebarIncidentTimer.textContent = timerText;
        }, 1000);
    }

    // ======================== CLEAR CHAT HISTORY ========================
    function clearChatHistory() {
        const channelId = state.currentChannelId;
        const ch = state.channels.find(c => c.id === channelId);
        const channelName = ch ? ch.name : channelId;

        showConfirm(
            'Clear Chat History',
            `Are you sure you want to clear all messages in "${channelName}"? This action cannot be undone.`,
            'delete_sweep',
            () => {
                state.messages[channelId] = [
                    { id: 'cleared-' + Date.now(), type: 'system', text: `Chat history cleared by ${state.currentUser.name}.`, time: Date.now(), sender: null }
                ];
                if (ch) {
                    ch.lastMessage = 'History cleared';
                    ch.lastTime = formatTime(Date.now());
                }
                renderMessages();
                renderChannels();
                showToast('Chat Cleared', `Messages in "${channelName}" have been cleared.`, 'info');
            }
        );
    }

    // ======================== CLEAR ALERTS ========================
    function clearAlerts() {
        showConfirm(
            'Clear All Alerts',
            'Are you sure you want to clear all alerts? This action cannot be undone.',
            'clear_all',
            () => {
                state.alerts = [];
                renderAlerts();
                showToast('Alerts Cleared', 'All alerts have been removed.', 'info');
            }
        );
    }

    // ======================== EVENT HANDLERS ========================
    function bindEvents() {
    // Send message - these exist
    if (DOM.btnSend) DOM.btnSend.addEventListener('click', handleSend);
    if (DOM.messageInput) {
        DOM.messageInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });
        DOM.messageInput.addEventListener('input', () => {
            if (DOM.charCount) DOM.charCount.textContent = `${DOM.messageInput.value.length} / 2000`;
            DOM.messageInput.style.height = 'auto';
            DOM.messageInput.style.height = Math.min(DOM.messageInput.scrollHeight, 120) + 'px';
            updateSendButton();
        });
    }

    // Severity buttons (if they exist)
    document.querySelectorAll('.severity-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.severity-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.currentSeverity = btn.dataset.severity;
            if (DOM.currentSeverityLabel) {
                const labels = { normal: 'Normal Message', info: 'ℹ️ Info', warning: '⚠️ Warning', critical: '🔴 Critical' };
                DOM.currentSeverityLabel.textContent = labels[state.currentSeverity] || 'Normal';
            }
        });
    });

    // Broadcast modal
    if (DOM.btnBroadcast) DOM.btnBroadcast.addEventListener('click', () => showModal('broadcast-modal'));
    const sendBroadcastBtn = document.getElementById('btn-send-broadcast');
    if (sendBroadcastBtn) sendBroadcastBtn.addEventListener('click', handleBroadcast);

    // Reset buttons
    if (DOM.btnResetIncident) DOM.btnResetIncident.addEventListener('click', resetIncident);
    if (DOM.sidebarBtnResetIncident) DOM.sidebarBtnResetIncident.addEventListener('click', resetIncident);

    // Settings
    if (DOM.btnSettings) DOM.btnSettings.addEventListener('click', () => {
        if (DOM.roleDropdown) DOM.roleDropdown.classList.remove('open');
        showModal('settings-modal');
    });

    const saveSettingsBtn = document.getElementById('btn-save-settings');
    if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', () => {
        const apiKey = document.getElementById('settings-api-key')?.value;
        if (apiKey) state.geminiApiKey = apiKey.trim();
        if (document.getElementById('setting-sound')) state.settings.soundEnabled = document.getElementById('setting-sound').checked;
        if (document.getElementById('setting-timestamps')) state.settings.showTimestamps = document.getElementById('setting-timestamps').checked;
        if (document.getElementById('setting-avatars')) state.settings.showAvatars = document.getElementById('setting-avatars').checked;
        hideModal('settings-modal');
        renderMessages();
        showToast('Settings Saved', 'Preferences updated.', 'success');
    });

    // Role switcher
    if (DOM.userBadge) {
        DOM.userBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            if (DOM.roleDropdown) DOM.roleDropdown.classList.toggle('open');
        });
    }

    const roleOptAdmin = document.getElementById('role-opt-admin');
    const roleOptGuest = document.getElementById('role-opt-guest');
    if (roleOptAdmin) roleOptAdmin.addEventListener('click', () => {
        if (DOM.roleDropdown) DOM.roleDropdown.classList.remove('open');
        switchRole('admin');
    });
    if (roleOptGuest) roleOptGuest.addEventListener('click', () => {
        if (DOM.roleDropdown) DOM.roleDropdown.classList.remove('open');
        switchRole('guest');
    });

    // Guest modal
    const guestFloor = document.getElementById('guest-floor');
    if (guestFloor) guestFloor.addEventListener('change', populateGuestRoomSelect);
    const assignBtn = document.getElementById('btn-assign-room');
    if (assignBtn) assignBtn.addEventListener('click', confirmGuestRole);

    // Guest quick actions
    document.querySelectorAll('.quick-btn').forEach(btn => {
        btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
    });

    // New channel
    if (DOM.btnNewChannel) DOM.btnNewChannel.addEventListener('click', () => showModal('new-channel-modal'));
    const createChannelBtn = document.getElementById('btn-create-channel');
    if (createChannelBtn) createChannelBtn.addEventListener('click', handleCreateChannel);

    // Clear buttons
    if (DOM.btnClearChat) DOM.btnClearChat.addEventListener('click', clearChatHistory);
    if (DOM.btnClearAlerts) DOM.btnClearAlerts.addEventListener('click', clearAlerts);

    // Confirm dialog
    const confirmBtn = document.getElementById('btn-confirm-action');
    if (confirmBtn) confirmBtn.addEventListener('click', () => {
        hideModal('confirm-modal');
        if (state._confirmCallback) {
            state._confirmCallback();
            state._confirmCallback = null;
        }
    });

    // Close modals
    document.querySelectorAll('.btn-close-modal, .btn-cancel').forEach(btn => {
        btn.addEventListener('click', () => {
            const modalId = btn.dataset.modal;
            if (modalId) hideModal(modalId);
        });
    });

    // Click outside modal
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) hideModal(overlay.id);
        });
    });

    // Channel search
    if (DOM.channelSearch) DOM.channelSearch.addEventListener('input', () => renderChannels(DOM.channelSearch.value));

    // Close pinned alert
    if (DOM.btnClosePinned) DOM.btnClosePinned.addEventListener('click', () => {
        if (DOM.pinnedAlert) DOM.pinnedAlert.style.display = 'none';
    });

    // Sidebar toggle
    if (DOM.btnToggleSidebar) {
        DOM.btnToggleSidebar.addEventListener('click', () => {
            if (DOM.sidebarChannels) DOM.sidebarChannels.classList.toggle('open');
        });
    }

    // Toggle right sidebar
    if (DOM.btnToggleAlerts) {
        DOM.btnToggleAlerts.addEventListener('click', () => {
            if (DOM.sidebarAlerts) {
                DOM.sidebarAlerts.classList.toggle('open');
                DOM.sidebarAlerts.style.display = DOM.sidebarAlerts.classList.contains('open') ? 'flex' : '';
            }
        });
    }

    // Escape closes modals
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay').forEach(m => {
                if (m.style.display !== 'none') hideModal(m.id);
            });
        }
    });

    // Attach file (optional)
    if (DOM.btnAttach) {
        DOM.btnAttach.addEventListener('click', () => {
            showToast('Attach Files', 'File attachment coming soon.', 'info');
        });
    }
}

    function handleSend() {
        const text = DOM.messageInput.value.trim();
        if (!text) return;

        if (state.currentRole === 'guest') {
            handleQuickAction('report');
        } else {
            sendMessage(text, state.currentSeverity);
        }

        DOM.messageInput.value = '';
        DOM.messageInput.style.height = 'auto';
        DOM.charCount.textContent = '0 / 2000';
        updateSendButton();
    }

    function handleBroadcast() {
        const severity = document.getElementById('broadcast-severity').value;
        const incidentType = document.getElementById('broadcast-incident-type').value;
        const floorKey = document.getElementById('broadcast-floor').value;
        const message = document.getElementById('broadcast-message').value.trim();
        const sendAIInstructions = document.getElementById('bc-ai-instructions')?.checked;

        if (!message) {
            showToast('Missing Info', 'Please fill in the message field.', 'warning');
            return;
        }

        broadcastAlert(severity, incidentType, floorKey, message);

        if (sendAIInstructions && floorKey !== 'all') {
            setTimeout(() => generateEmergencyInstructions(incidentType, floorKey), 1500);
        } else if (sendAIInstructions && floorKey === 'all') {
            let delayMs = 1500;
            Object.keys(FLOOR_PLAN).forEach(fk => {
                setTimeout(() => generateEmergencyInstructions(incidentType, fk), delayMs);
                delayMs += 2000;
            });
        }

        hideModal('broadcast-modal');
        document.getElementById('broadcast-message').value = '';
    }

    async function handleAIVerify() {
        const report = document.getElementById('ai-incident-report').value.trim();
        const source = document.getElementById('ai-source').value;

        if (!report) {
            showToast('Missing Report', 'Please enter an incident report.', 'warning');
            return;
        }

        const btn = document.getElementById('btn-submit-ai-verify');
        btn.disabled = true;
        btn.innerHTML = '<span class="material-icons-round" style="animation:spin 1s linear infinite">autorenew</span> Analyzing...';

        if (!document.getElementById('spin-style')) {
            const style = document.createElement('style');
            style.id = 'spin-style';
            style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
            document.head.appendChild(style);
        }

        try {
            const result = await verifyWithAI(report, source);
            if (result) {
                displayAIResult(result);
                state.alerts.unshift({
                    id: 'ai-' + Date.now(),
                    type: result.credibility_score >= 70 ? 'critical' : result.credibility_score >= 40 ? 'warning' : 'info',
                    title: `AI Verified: ${result.severity.toUpperCase()} — ${result.credibility_score}%`,
                    desc: result.risk_assessment || result.analysis?.substring(0, 80),
                    time: Date.now(),
                    icon: 'psychology'
                });
                renderAlerts();
            }
        } catch (err) {
            showToast('AI Error', err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span class="material-icons-round">auto_awesome</span> Analyze with Gemini AI';
        }
    }

    function displayAIResult(result) {
        DOM.aiResult.style.display = 'block';
        const score = result.credibility_score || 0;
        setTimeout(() => { DOM.aiConfidenceFill.style.width = score + '%'; }, 100);
        DOM.aiConfidenceValue.textContent = score + '%';

        const badgeClasses = { low: 'badge-low', medium: 'badge-medium', high: 'badge-high', critical: 'badge-high' };
        DOM.aiSeverityBadge.className = `ai-severity-badge ${badgeClasses[result.severity] || ''}`;
        DOM.aiSeverityBadge.textContent = `${result.severity?.toUpperCase()} SEVERITY${result.is_likely_real ? ' — LIKELY REAL' : ' — NEEDS VERIFICATION'}`;

        DOM.aiAnalysisText.textContent = result.analysis || 'No analysis available.';

        DOM.aiRecommendedActions.innerHTML = '';
        (result.recommended_actions || []).forEach(action => {
            const el = document.createElement('div');
            el.className = 'ai-action-item';
            el.innerHTML = `<span class="material-icons-round">arrow_forward</span><span>${sanitize(action)}</span>`;
            DOM.aiRecommendedActions.appendChild(el);
        });
    }

    function handleCreateChannel() {
        const name = document.getElementById('new-channel-name').value.trim();
        const type = document.getElementById('new-channel-type').value;
        const icon = document.getElementById('new-channel-icon').value || '🏢';

        if (!name) {
            showToast('Missing Name', 'Please enter a channel name.', 'warning');
            return;
        }

        const newChannel = {
            id: 'ch-' + Date.now(),
            name, type, icon,
            members: 0, unread: 0,
            lastMessage: 'Channel created',
            lastTime: formatTime(Date.now())
        };

        state.channels.push(newChannel);
        state.messages[newChannel.id] = [
            { id: 'sys-' + Date.now(), type: 'system', text: `Channel "${name}" created by ${state.currentUser.name}`, time: Date.now(), sender: null }
        ];

        renderChannels();
        hideModal('new-channel-modal');
        showToast('Channel Created', `"${name}" is now available.`, 'success');
        document.getElementById('new-channel-name').value = '';
        document.getElementById('new-channel-icon').value = 'room';
        selectChannel(newChannel.id);
    }

    // ======================== MODAL HELPERS ========================
    function showModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.style.display = 'flex';
    }

    function hideModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.style.display = 'none';
    }

    // ======================== INITIALIZATION ========================
    async function init() {
        cacheDom();
        
        // ── Load Real Graph and Participants ──
        const graph = await apiFetch('/api/graph');
        if (graph && graph.nodePositions) {
            const allNodes = Object.keys(graph.nodePositions);
            const rooms = allNodes.filter(k => !isNaN(k) || k.toLowerCase().startsWith('room'));
            const meetingPoints = allNodes.filter(k => k.toLowerCase().startsWith('m'));
            
            FLOOR_PLAN['1'].rooms = rooms.sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));
            state.meetingPoints = meetingPoints; // Store separately if needed
        } else {
            // Default rooms if no graph
            FLOOR_PLAN['1'].rooms = ['1','2','3','4','5','6','7','8','9','10'];
        }

        seedData();
        renderChannels();
        renderMessages();
        renderAlerts();
        renderStaff();
        renderRoomGrid();
        startIncidentTimer();
        bindEvents();
        updateStats();
        updateSendButton();
        updateIncidentUI();

        // ── Real Data Sync loop ──
        await syncWithBackend();
        setInterval(syncWithBackend, 4000);

        // Guest-only elements hidden by default
        document.querySelectorAll('.guest-only').forEach(el => el.style.display = 'none');

        setTimeout(() => {
            showToast('System Online', 'Emergency Command Messenger v3.0 — Real-time Room Graph Connected.', 'success');
        }, 800);

        console.log('%c🚨 Emergency Command Messenger v3.0 initialized with DB sync', 'color:#ef4444;font-size:14px;font-weight:bold');
    }

   async function syncWithBackend() {
    try {
        const [users, logs, fireState] = await Promise.all([
            apiFetch('/api/users'),
            apiFetch('/api/logs'),
            apiFetch('/api/fire')
        ]);

        if (DOM.connectionDot) {
            DOM.connectionDot.classList.add('active');
            DOM.connectionDot.classList.remove('offline');
            DOM.connectionDot.title = 'System Live - ' + new Date().toLocaleTimeString();
        }

        if (users) {
            allUsers = users; // module-level cache

            // ── Staff list ──
            const apiStaff = users.filter(u => u.type === 'staff');
            state.staff = apiStaff.map(u => ({
                id: u._id,
                name: u.name,
                initials: u.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase(),
                role: u.role === 'rescue' ? 'Rescue Team' : 'Evacuation Team',
                status: u.status === 'moving' ? 'on-route' : (u.status || 'active'),
                node: u.node || 'Base',
                color: u.role === 'rescue' ? '#ff4d4d' : '#22c55e'
            }));

            const guests = users.filter(u => u.type === 'guest');

            // ── Room grid status from guests ──
            Object.keys(state.rooms).forEach(floorKey => {
                state.rooms[floorKey].forEach(room => {
                    const guestInRoom = guests.find(g =>
                        g.node === room.num ||
                        g.node === `Room ${room.num}` ||
                        (room.num.startsWith('Room') && g.node === room.num.replace('Room ', ''))
                    );
                    if (guestInRoom) {
                        room.status = guestInRoom.status;
                        room.lastUpdate = `${guestInRoom.name}: ${guestInRoom.status.toUpperCase()}`;
                        room.lastUpdateTime = new Date(guestInRoom.updatedAt || Date.now()).getTime();
                    } else {
                        const isFire = fireState?.blockedNodes?.includes(room.num);
                        room.status = isFire ? 'alert' : 'safe';
                        room.lastUpdate = isFire ? '🔥 FIRE INCIDENT' : 'Room Empty';
                    }
                });
            });

            // ── Room channel previews ──
            state.channels.forEach(ch => {
                if (ch.type === 'room') {
                    const roomNum = ch.id.replace('room-', '');
                    const guestInRoom = guests.find(g =>
                        g.node === roomNum || g.node === `Room ${roomNum}`
                    );
                    if (guestInRoom) {
                        ch.members = 1;
                        ch.lastMessage = `OCCUPANT: ${guestInRoom.name}: ${guestInRoom.status.toUpperCase()}`;
                        ch.lastTime = formatTime(guestInRoom.updatedAt || Date.now());
                        if (guestInRoom.status === 'help') ch.hasAlert = true;
                    } else {
                        ch.members = 0;
                        ch.lastMessage = 'No occupants';
                    }
                }
            });

            // ── Safe / Unsafe guest channels ──
            const unsafe = guests.filter(g => g.status === 'help' || g.status === 'moving');
            const safe   = guests.filter(g => g.status === 'safe');

            const unsafeCh = state.channels.find(c => c.id === 'unsafe-guests');
            if (unsafeCh) {
                unsafeCh.members = unsafe.length;
                unsafeCh.lastMessage = unsafe.length > 0
                    ? `NEED HELP: ${unsafe.map(g => g.name).slice(0, 3).join(', ')}${unsafe.length > 3 ? '...' : ''}`
                    : 'No guests currently in danger';
                unsafeCh.hasAlert = unsafe.length > 0;
                unsafeCh.lastTime = formatTime(Date.now());
            }

            const safeCh = state.channels.find(c => c.id === 'safe-guests');
            if (safeCh) {
                safeCh.members = safe.length;
                safeCh.lastMessage = safe.length > 0
                    ? `SAFE: ${safe.map(g => g.name).slice(0, 3).join(', ')}${safe.length > 3 ? '...' : ''}`
                    : 'No safe reports received yet';
                safeCh.lastTime = formatTime(Date.now());
            }

            const allEmCh = state.channels.find(c => c.id === 'all-emergency');
            if (allEmCh) allEmCh.members = guests.length;

            renderChannels();

            // ── If currently viewing a roster channel, live-refresh it ──
            if (state.currentChannelId === 'safe-guests' ||
                state.currentChannelId === 'unsafe-guests') {
                renderMessages();
            }
        }

        // ── Incident / fire state ──
        const isIncident = fireState &&
            (fireState.status === 'active' || fireState.simulationRunning === true);

        if (isIncident) {
            const fireNode = fireState.node || fireState.blockedNodes?.[0] || 'Node ?';
            const statusText = `🔥 FIRE INCIDENT - NODE ${fireNode}`;

            state.incidentActive = true;
            // Stricter start time check
            const dbStartTime = fireState.createdAt ? new Date(fireState.createdAt).getTime() : null;
            state.incidentStartTime = dbStartTime || state.incidentStartTime || Date.now();
            state.fireNodes = fireState.blockedNodes || [fireNode];

            if (DOM.incidentTag) DOM.incidentTag.textContent = statusText;
            if (DOM.sidebarIncidentTag) DOM.sidebarIncidentTag.textContent = statusText;
            
            if (DOM.incidentTag) DOM.incidentTag.classList.add('active');
            if (DOM.sidebarIncidentTag) DOM.sidebarIncidentTag.classList.add('active');
            if (DOM.activeIncidentCard) DOM.activeIncidentCard.classList.add('active');

            DOM.pinnedAlert.style.display = 'flex';
            DOM.pinnedAlertText.textContent = `🚨 CRITICAL ALERT: Fire detected at Node ${fireNode}. Automated emergency protocol active.`;
            
            if (DOM.btnResetIncident) DOM.btnResetIncident.style.display = 'flex';
            if (DOM.sidebarBtnResetIncident) DOM.sidebarBtnResetIncident.style.display = 'flex';
        } else {
            // FORCE CLEAR EVERYTHING
            state.incidentActive = false;
            state.incidentStartTime = null;
            state.fireNodes = [];

            const statusText = 'NO ACTIVE INCIDENT';
            if (DOM.incidentTag) DOM.incidentTag.textContent = statusText;
            if (DOM.sidebarIncidentTag) DOM.sidebarIncidentTag.textContent = statusText;
            
            if (DOM.incidentTag) DOM.incidentTag.classList.remove('active');
            if (DOM.sidebarIncidentTag) DOM.sidebarIncidentTag.classList.remove('active');
            if (DOM.activeIncidentCard) DOM.activeIncidentCard.classList.remove('active');

            if (DOM.incidentTimer) DOM.incidentTimer.textContent = '00:00:00';
            if (DOM.sidebarIncidentTimer) DOM.sidebarIncidentTimer.textContent = '00:00:00';

            DOM.pinnedAlert.style.display = 'none';
            
            if (DOM.btnResetIncident) DOM.btnResetIncident.style.display = 'none';
            if (DOM.sidebarBtnResetIncident) DOM.sidebarBtnResetIncident.style.display = 'none';
        }

        // ── Logs → alert feed ──
        if (logs) {
            state.alerts = logs.slice(0, 15).map(log => ({
                id: log._id,
                type: log.message.toLowerCase().includes('fire') ? 'critical' : 'info',
                title: log.message,
                desc: formatTime(log.timestamp),
                time: new Date(log.timestamp).getTime(),
                icon: log.message.toLowerCase().includes('fire')
                    ? 'local_fire_department' : 'info'
            }));
        }

        renderAlerts();
        renderStaff();
        renderRoomGrid();
        updateStats();

    } catch (err) {
        console.error('[SYNC ERROR]', err);
        if (DOM.connectionDot) {
            DOM.connectionDot.classList.remove('active');
            DOM.connectionDot.classList.add('offline');
            DOM.connectionDot.title = 'System Offline - Reconnecting...';
        }
    }
}

    // ======================== PUBLIC API ========================
    window.EmergencyMessenger = {
        sendMessage: (channelId, text, severity) => sendMessage(text, severity || 'normal', channelId),
        broadcastAlert,
        addChannel: (name, type, icon) => {
            const ch = { id: 'ch-' + Date.now(), name, type: type || 'floor', icon: icon || '🏢', members: 0, unread: 0, lastMessage: '', lastTime: '' };
            state.channels.push(ch);
            state.messages[ch.id] = [];
            renderChannels();
            return ch;
        },
        getChannels: () => [...state.channels],
        getMessages: (channelId) => [...(state.messages[channelId] || [])],
        selectChannel,
        onMessage: (cb) => on('message', cb),
        onBroadcast: (cb) => on('broadcast', cb),
        onAlert: (cb) => on('alert', cb),
        onChannelChange: (cb) => on('channelChange', cb),
        setCurrentUser: (name, role) => {
            state.currentUser.name = name;
            state.currentUser.role = role;
            state.currentUser.initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
            DOM.userAvatarText.textContent = state.currentUser.initials;
            DOM.userNameText.textContent = name;
        },
        switchRole,
        addAlert: (type, title, desc, icon) => {
            const alert = { id: 'ext-' + Date.now(), type, title, desc, time: Date.now(), icon: icon || 'warning' };
            state.alerts.unshift(alert);
            renderAlerts();
            emit('alert', alert);
            return alert;
        },
        updateRoomStatus,
        updateFloorRoomStatus,
        generateEmergencyInstructions,
        resetIncident,
        showToast,
        verifyIncident: verifyWithAI,
        setGeminiApiKey: (key) => { state.geminiApiKey = key; },
        getState: () => JSON.parse(JSON.stringify(state))
    };

    // Boot
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();