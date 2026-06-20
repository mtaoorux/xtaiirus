// ==================== MixVibe Mirror - Admin Panel Script ====================
const API_BASE = window.location.origin;
let statsInterval;

// ==================== API Functions ====================
async function fetchAPI(endpoint, options = {}) {
    try {
        const response = await fetch(API_BASE + endpoint, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        logTerminal(`❌ API Error: ${error.message}`);
        throw error;
    }
}

// ==================== Stats Refresh ====================
async function refreshStats() {
    try {
        const stats = await fetchAPI('/api/stats');
        
        // Update stat cards
        updateStatCard('statBatches', 'statBatchesSize', stats.files.batches);
        updateStatCard('statDetails', 'statDetailsSize', stats.files.batchdetails);
        updateStatCard('statLive', 'statLiveSize', stats.files.live);
        updateStatCard('statTopics', 'statTopicsSize', stats.files.topics);
        updateStatCard('statContent', 'statContentSize', stats.files.content);
        
        // Total stats
        document.getElementById('statTotal').textContent = stats.totalSize.mb;
        document.getElementById('statTotalSize').textContent = `${stats.totalSize.gb} GB (${stats.totalSize.bytes.toLocaleString()} bytes)`;
        
        // Update extraction status
        updateExtractionStatus(stats);
        
        // Update server info
        updateServerInfo(stats);
        
        // Update button states
        document.getElementById('extractBtn').disabled = stats.extraction.running;
        document.getElementById('extractAllBtn').disabled = stats.extraction.running;
        
    } catch (error) {
        logTerminal('Error refreshing stats: ' + error.message);
    }
}

function updateStatCard(valueId, sizeId, data) {
    if (data) {
        document.getElementById(valueId).textContent = data.count || 0;
        const sizeMB = ((data.size || 0) / (1024 * 1024)).toFixed(2);
        document.getElementById(sizeId).textContent = `${sizeMB} MB`;
    }
}

function updateExtractionStatus(stats) {
    const statusText = document.getElementById('statusText');
    const progressBar = document.getElementById('progressBar');
    const details = document.getElementById('extractionDetails');
    
    if (stats.extraction.running) {
        const extStats = stats.extraction.stats;
        const total = extStats.total || 0;
        const processed = extStats.processed || 0;
        const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : 0;
        
        statusText.innerHTML = `
            <span class="running">⏳ Extracting: <strong>${processed}/${total}</strong> batches (${pct}%)</span><br>
            <small>Current: ${extStats.currentBatch || 'Starting...'}</small>
        `;
        progressBar.style.width = pct + '%';
        
        details.innerHTML = `
            📚 Subjects: ${extStats.totalSubjects || 0} | 
            📖 Topics: ${extStats.totalTopics || 0} | 
            📄 Content: ${extStats.totalContent || 0}<br>
            ⏱️ Started: ${extStats.startTime ? new Date(extStats.startTime).toLocaleString() : 'N/A'}
        `;
    } else {
        statusText.innerHTML = '✅ Idle - Ready for extraction';
        progressBar.style.width = '0%';
        details.innerHTML = `Last run: ${stats.extraction.stats.lastRun ? new Date(stats.extraction.stats.lastRun).toLocaleString() : 'Never'}`;
    }
}

function updateServerInfo(stats) {
    const server = stats.server || {};
    const uptimeHours = (server.uptime / 3600).toFixed(1);
    const memoryMB = server.memory ? (server.memory.heapUsed / (1024 * 1024)).toFixed(2) : 'N/A';
    
    document.getElementById('serverDetails').innerHTML = `
        <div class="server-stat">⏱️ Uptime: <span>${uptimeHours}h</span></div>
        <div class="server-stat">💾 Memory: <span>${memoryMB} MB</span></div>
        <div class="server-stat">🟢 Node.js: <span>${server.nodeVersion || 'N/A'}</span></div>
        <div class="server-stat">🖥️ Platform: <span>${server.platform || 'N/A'}</span></div>
        <div class="server-stat">🔒 Protected: <span>${stats.dataProtected ? 'Yes ✅' : 'No ❌'}</span></div>
    `;
}

// ==================== Extraction Controls ====================
async function startExtraction() {
    const btn = document.getElementById('extractBtn');
    btn.disabled = true;
    
    try {
        logTerminal('🔄 Starting extraction...');
        const data = await fetchAPI('/api/extract', { method: 'POST' });
        logTerminal('✅ ' + data.message);
        refreshStats();
    } catch (error) {
        logTerminal('❌ Error: ' + error.message);
    }
    
    btn.disabled = false;
}

async function forceExtractAll() {
    if (!confirm('⚠️ This will extract all new content. Existing data is SAFE and will not be overwritten.\n\nContinue?')) {
        return;
    }
    
    const btn = document.getElementById('extractAllBtn');
    btn.disabled = true;
    
    try {
        logTerminal('⚡ Starting FULL extraction...');
        const data = await fetchAPI('/api/extract-all', { method: 'POST' });
        logTerminal('✅ ' + data.message);
        refreshStats();
    } catch (error) {
        logTerminal('❌ Error: ' + error.message);
    }
    
    btn.disabled = false;
}

async function exportData() {
    try {
        logTerminal('📥 Preparing export...');
        window.open(API_BASE + '/api/export?format=json', '_blank');
        logTerminal('✅ Export started - check your downloads');
    } catch (error) {
        logTerminal('❌ Error: ' + error.message);
    }
}

// ==================== Terminal Logging ====================
function logTerminal(message) {
    const terminal = document.getElementById('terminal');
    const time = new Date().toLocaleTimeString();
    terminal.innerHTML += `<div class="terminal-line">[${time}] ${message}</div>`;
    terminal.scrollTop = terminal.scrollHeight;
    
    // Keep only last 100 lines
    const lines = terminal.querySelectorAll('.terminal-line');
    if (lines.length > 100) {
        lines[0].remove();
    }
}

// ==================== Keyboard Shortcuts ====================
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'e') {
        e.preventDefault();
        startExtraction();
    } else if (e.ctrlKey && e.key === 'r') {
        e.preventDefault();
        refreshStats();
    } else if (e.ctrlKey && e.key === 'x') {
        e.preventDefault();
        exportData();
    }
});

// ==================== Initialize ====================
async function init() {
    logTerminal('> MixVibe Mirror Admin Panel initialized');
    logTerminal('> 🔒 Data Protection: Active');
    logTerminal('> Shortcuts: Ctrl+E = Extract | Ctrl+R = Refresh | Ctrl+X = Export');
    logTerminal('> Auto-refresh every 3 seconds');
    
    await refreshStats();
    
    // Auto-refresh stats every 3 seconds
    statsInterval = setInterval(refreshStats, 3000);
}

// Start the app
init();

// ==================== Cleanup on page unload ====================
window.addEventListener('beforeunload', () => {
    if (statsInterval) clearInterval(statsInterval);
});
