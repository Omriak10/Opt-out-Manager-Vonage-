// Only load dotenv if running locally (not in VCR)
if (!process.env.VCR_PORT) {
    try {
        require('dotenv').config();
    } catch (e) {
        // dotenv not installed, that's ok for VCR
    }
}

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

// VCR Cloud Runtime compatibility - VCR_PORT and VCR_HOST take precedence
const PORT = process.env.VCR_PORT || process.env.PORT || 3000;
const HOST = process.env.VCR_HOST || process.env.HOST || '0.0.0.0';
const IS_VCR = !!process.env.VCR_PORT;

// Configuration from environment (set in vcr.yml) or file
const ENV_API_KEY = process.env.VONAGE_API_KEY;
const ENV_API_SECRET = process.env.VONAGE_API_SECRET;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// In-memory logs storage (last 500 logs)
const MAX_LOGS = 500;
let inMemoryLogs = [];

function addLog(message, level = 'info') {
    const logEntry = {
        timestamp: new Date().toISOString(),
        level,
        message
    };
    inMemoryLogs.push(logEntry);
    if (inMemoryLogs.length > MAX_LOGS) {
        inMemoryLogs = inMemoryLogs.slice(-MAX_LOGS);
    }
    // Also log to console
    console.log(`[${level.toUpperCase()}] ${message}`);
}

// ========== PERSISTENT STORAGE LAYER ==========
// Uses VCR state when on VCR, file system when local

let vcrState = null;

// Initialize VCR SDK if running on VCR
if (IS_VCR) {
    try {
        const { vcr } = require('@vonage/vcr-sdk');
        // Try to get global state (persists across instances)
        vcrState = vcr.getGlobalState();
        addLog('VCR global state storage initialized - data will persist across restarts');
    } catch (e) {
        try {
            // Fallback: try instance state
            const { vcr } = require('@vonage/vcr-sdk');
            vcrState = vcr.getInstanceState();
            addLog('VCR instance state storage initialized');
        } catch (e2) {
            addLog(`VCR SDK not available: ${e.message}. Using file storage.`, 'warn');
        }
    }
}

// Data storage paths (for local development fallback)
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');
const OPTOUT_FILE = path.join(DATA_DIR, 'optouts.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Storage keys for VCR state
const STORAGE_KEYS = {
    config: 'optout_config',
    credentials: 'optout_credentials', 
    optouts: 'optout_list',
    history: 'optout_history'
};

// Ensure data directory exists (for local)
if (!IS_VCR && !fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

// Default data
const defaultCredentials = ENV_API_KEY && ENV_API_SECRET ? {
    apiKey: ENV_API_KEY,
    apiSecret: ENV_API_SECRET,
    isLocked: true
} : {
    apiKey: '',
    apiSecret: '',
    isLocked: false
};

const defaultConfig = {
    optoutConfigs: [],
    customSenders: []
};

// In-memory cache for faster reads
let dataCache = {
    config: null,
    credentials: null,
    optouts: null,
    history: null
};

// Async storage functions
async function readData(key) {
    // Return from cache if available
    if (dataCache[key] !== null) {
        return dataCache[key];
    }
    
    if (vcrState) {
        // Use VCR state
        try {
            const data = await vcrState.get(STORAGE_KEYS[key]);
            if (data) {
                dataCache[key] = JSON.parse(data);
                return dataCache[key];
            }
        } catch (e) {
            addLog(`Error reading ${key} from VCR state: ${e.message}`, 'error');
        }
    }
    
    // Fall back to file system
    const fileMap = {
        config: CONFIG_FILE,
        credentials: CREDENTIALS_FILE,
        optouts: OPTOUT_FILE,
        history: HISTORY_FILE
    };
    
    try {
        if (fs.existsSync(fileMap[key])) {
            dataCache[key] = JSON.parse(fs.readFileSync(fileMap[key], 'utf8'));
            return dataCache[key];
        }
    } catch (e) {
        addLog(`Error reading ${key} from file: ${e.message}`, 'error');
    }
    
    // Return defaults
    const defaults = {
        config: defaultConfig,
        credentials: defaultCredentials,
        optouts: [],
        history: []
    };
    
    return defaults[key];
}

async function writeData(key, data) {
    // Update cache
    dataCache[key] = data;
    
    if (vcrState) {
        // Save to VCR state
        try {
            await vcrState.set(STORAGE_KEYS[key], JSON.stringify(data));
            addLog(`Saved ${key} to VCR persistent state`);
            return true;
        } catch (e) {
            addLog(`Error writing ${key} to VCR state: ${e.message}`, 'error');
        }
    }
    
    // Fall back to file system
    const fileMap = {
        config: CONFIG_FILE,
        credentials: CREDENTIALS_FILE,
        optouts: OPTOUT_FILE,
        history: HISTORY_FILE
    };
    
    try {
        fs.writeFileSync(fileMap[key], JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        addLog(`Error writing ${key} to file: ${e.message}`, 'error');
        return false;
    }
}

// Initialize default data
async function initializeStorage() {
    // Initialize each data type with defaults if not exists
    const config = await readData('config');
    if (!config || !config.optoutConfigs) {
        await writeData('config', defaultConfig);
    }
    
    const credentials = await readData('credentials');
    if (!credentials || (!credentials.apiKey && !ENV_API_KEY)) {
        await writeData('credentials', defaultCredentials);
    }
    
    const optouts = await readData('optouts');
    if (!optouts) {
        await writeData('optouts', []);
    }
    
    const history = await readData('history');
    if (!history) {
        await writeData('history', []);
    }
    
    addLog(`Storage initialized (${IS_VCR ? 'VCR persistent state' : 'local files'})`);
}

// Synchronous wrappers for backward compatibility (using cache)
function readJSON(key) {
    if (dataCache[key] !== null) {
        return dataCache[key];
    }
    
    // Fallback to file for sync reads (local dev)
    const fileMap = {
        config: CONFIG_FILE,
        credentials: CREDENTIALS_FILE,
        optouts: OPTOUT_FILE,
        history: HISTORY_FILE
    };
    
    try {
        if (fs.existsSync(fileMap[key])) {
            return JSON.parse(fs.readFileSync(fileMap[key], 'utf8'));
        }
    } catch (e) {}
    
    const defaults = {
        config: defaultConfig,
        credentials: defaultCredentials,
        optouts: [],
        history: []
    };
    
    return defaults[key];
}

function writeJSON(key, data) {
    dataCache[key] = data;
    writeData(key, data); // Fire async write
}

// Get active credentials (environment takes priority)
function getActiveCredentials() {
    if (ENV_API_KEY && ENV_API_SECRET) {
        return {
            apiKey: ENV_API_KEY,
            apiSecret: ENV_API_SECRET,
            isLocked: true,
            source: 'environment'
        };
    }
    return { ...readJSON("credentials"), source: 'file' };
}

// Health check endpoint for VCR
app.get('/_/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Storage status endpoint
app.get('/api/storage-status', async (req, res) => {
    const config = await readData('config');
    const optouts = await readData('optouts');
    const history = await readData('history');
    
    res.json({
        storageType: IS_VCR && vcrState ? 'VCR Persistent State' : 'Local Files',
        persistent: IS_VCR && vcrState ? true : false,
        data: {
            configurations: (config?.optoutConfigs || []).length,
            customSenders: (config?.customSenders || []).length,
            optedOutNumbers: (optouts || []).length,
            historyEntries: (history || []).length
        },
        message: IS_VCR && vcrState 
            ? 'Data is stored in VCR persistent state and will survive restarts' 
            : 'Data is stored in local files (will be lost on VCR restart)'
    });
});

// Get logs
app.get('/api/logs', (req, res) => {
    res.json(inMemoryLogs);
});

// Clear logs
app.delete('/api/logs', (req, res) => {
    inMemoryLogs = [];
    addLog('Logs cleared');
    res.json({ success: true });
});

// Get credentials
app.get('/api/credentials', (req, res) => {
    const credentials = getActiveCredentials();
    // Mask the secret if locked
    if (credentials.isLocked) {
        res.json({
            apiKey: credentials.apiKey,
            apiSecret: '••••••••',
            isLocked: true,
            source: credentials.source
        });
    } else {
        res.json(credentials);
    }
});

// Save and lock credentials
app.post('/api/credentials', (req, res) => {
    // If using environment variables, don't allow changing
    if (ENV_API_KEY && ENV_API_SECRET) {
        return res.status(400).json({ error: 'Credentials are set via environment variables and cannot be changed' });
    }
    
    const { apiKey, apiSecret } = req.body;
    const credentials = {
        apiKey,
        apiSecret,
        isLocked: true
    };
    writeJSON("credentials", credentials);
    res.json({ success: true });
});

// Unlock credentials for editing
app.post('/api/credentials/unlock', (req, res) => {
    // If using environment variables, don't allow unlocking
    if (ENV_API_KEY && ENV_API_SECRET) {
        return res.status(400).json({ error: 'Credentials are set via environment variables and cannot be changed' });
    }
    
    const credentials = readJSON("credentials");
    credentials.isLocked = false;
    writeJSON("credentials", credentials);
    res.json({ 
        success: true,
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret
    });
});

// Get all opt-out configs
app.get('/api/config', (req, res) => {
    const config = readJSON("config");
    res.json(config);
});

// Save all opt-out configs
app.post('/api/config', (req, res) => {
    const config = req.body;
    writeJSON("config", config);
    res.json({ success: true });
});

// Add new opt-out config
app.post('/api/config/add', (req, res) => {
    const config = readJSON("config");
    const newConfig = {
        id: Date.now().toString(),
        optoutNumber: req.body.optoutNumber || '',
        optoutPhrase: req.body.optoutPhrase || 'STOP',
        optinPhrase: req.body.optinPhrase || 'START'
    };
    config.optoutConfigs.push(newConfig);
    writeJSON("config", config);
    res.json({ success: true, config: newConfig });
});

// Update specific opt-out config
app.put('/api/config/:id', (req, res) => {
    const config = readJSON("config");
    const index = config.optoutConfigs.findIndex(c => c.id === req.params.id);
    if (index > -1) {
        config.optoutConfigs[index] = { ...config.optoutConfigs[index], ...req.body };
        writeJSON("config", config);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Config not found' });
    }
});

// Delete specific opt-out config
app.delete('/api/config/:id', (req, res) => {
    const config = readJSON("config");
    config.optoutConfigs = config.optoutConfigs.filter(c => c.id !== req.params.id);
    writeJSON("config", config);
    res.json({ success: true });
});

// Get numbers from Vonage account (includes custom senders)
app.get('/api/numbers', async (req, res) => {
    const credentials = getActiveCredentials();
    const config = readJSON("config");
    const customSenders = config.customSenders || [];
    
    if (!credentials.apiKey || !credentials.apiSecret) {
        // Return only custom senders if no credentials
        const senderNumbers = customSenders.map(s => ({
            msisdn: s.senderId,
            country: 'ALPHA',
            type: 'alphanumeric',
            features: ['SMS'],
            isCustom: true
        }));
        return res.json(senderNumbers);
    }

    try {
        const response = await fetch(
            `https://rest.nexmo.com/account/numbers?api_key=${credentials.apiKey}&api_secret=${credentials.apiSecret}`,
            { method: 'GET' }
        );
        const data = await response.json();
        
        // Combine Vonage numbers with custom senders
        const vonageNumbers = data.numbers || [];
        const customNumbers = customSenders.map(s => ({
            msisdn: s.senderId,
            country: 'ALPHA',
            type: 'alphanumeric',
            features: ['SMS'],
            isCustom: true
        }));
        
        res.json([...vonageNumbers, ...customNumbers]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== CUSTOM SENDERS API ==========

// Get all custom senders
app.get('/api/senders', (req, res) => {
    const config = readJSON("config");
    res.json(config.customSenders || []);
});

// Add custom sender
app.post('/api/senders', (req, res) => {
    const { senderId, description } = req.body;
    
    if (!senderId) {
        return res.status(400).json({ error: 'senderId is required' });
    }
    
    // Validate alphanumeric sender ID (3-11 chars, alphanumeric only)
    if (!/^[a-zA-Z0-9]{3,11}$/.test(senderId)) {
        return res.status(400).json({ 
            error: 'Sender ID must be 3-11 alphanumeric characters only' 
        });
    }
    
    const config = readJSON("config");
    if (!config.customSenders) {
        config.customSenders = [];
    }
    
    // Check if sender already exists
    if (config.customSenders.some(s => s.senderId.toLowerCase() === senderId.toLowerCase())) {
        return res.status(400).json({ error: 'Sender ID already exists' });
    }
    
    const newSender = {
        id: Date.now().toString(),
        senderId: senderId,
        description: description || '',
        createdAt: new Date().toISOString()
    };
    
    config.customSenders.push(newSender);
    writeJSON("config", config);
    
    addLog(`Custom sender added: ${senderId}`);
    
    res.json({ success: true, sender: newSender });
});

// Delete custom sender
app.delete('/api/senders/:id', (req, res) => {
    const { id } = req.params;
    const config = readJSON("config");
    
    if (!config.customSenders) {
        return res.status(404).json({ error: 'Sender not found' });
    }
    
    const initialLength = config.customSenders.length;
    config.customSenders = config.customSenders.filter(s => s.id !== id);
    
    if (config.customSenders.length === initialLength) {
        return res.status(404).json({ error: 'Sender not found' });
    }
    
    writeJSON("config", config);
    
    addLog(`Custom sender deleted: ${id}`);
    
    res.json({ success: true });
});

// Bulk add custom senders
app.post('/api/senders/bulk', (req, res) => {
    const { senders } = req.body;
    
    if (!senders || !Array.isArray(senders) || senders.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid senders array' });
    }
    
    const config = readJSON("config");
    if (!config.customSenders) {
        config.customSenders = [];
    }
    
    const results = {
        added: [],
        failed: []
    };
    
    for (const sender of senders) {
        const senderId = typeof sender === 'string' ? sender : sender.senderId;
        const description = typeof sender === 'string' ? '' : (sender.description || '');
        
        // Validate
        if (!/^[a-zA-Z0-9]{3,11}$/.test(senderId)) {
            results.failed.push({ senderId, reason: 'Invalid format (must be 3-11 alphanumeric chars)' });
            continue;
        }
        
        // Check duplicate
        if (config.customSenders.some(s => s.senderId.toLowerCase() === senderId.toLowerCase())) {
            results.failed.push({ senderId, reason: 'Already exists' });
            continue;
        }
        
        config.customSenders.push({
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            senderId,
            description,
            createdAt: new Date().toISOString()
        });
        
        results.added.push(senderId);
    }
    
    writeJSON("config", config);
    
    addLog(`Bulk senders added: ${results.added.length} success, ${results.failed.length} failed`);
    
    res.json({
        success: true,
        summary: {
            total: senders.length,
            added: results.added.length,
            failed: results.failed.length
        },
        results
    });
});

// Check if a number is blocked
app.get('/api/check/:number', (req, res) => {
    const number = normalizeNumber(req.params.number);
    const optouts = readJSON("optouts");
    
    const blocked = optouts.some(o => {
        const optoutNumber = normalizeNumber(typeof o === 'string' ? o : o.number);
        return optoutNumber === number;
    });
    
    res.json({ number, blocked });
});

// Send SMS with blocklist checking
app.post('/api/send', async (req, res) => {
    const credentials = getActiveCredentials();
    
    if (!credentials.apiKey || !credentials.apiSecret) {
        return res.status(400).json({ error: 'API credentials not configured' });
    }
    
    const { to, from, text } = req.body;
    
    if (!to || !from || !text) {
        return res.status(400).json({ error: 'Missing required fields: to, from, text' });
    }
    
    // Clean the "to" number
    const cleanTo = normalizeNumber(to);
    
    // Check if number is blocked
    const optouts = readJSON("optouts");
    const blocked = optouts.some(o => {
        const optoutNumber = normalizeNumber(typeof o === 'string' ? o : o.number);
        return optoutNumber === cleanTo;
    });
    
    if (blocked) {
        return res.status(403).json({ 
            error: 'Number is opted out', 
            to: cleanTo,
            blocked: true,
            status: 'rejected'
        });
    }
    
    // Send via Vonage
    try {
        const response = await fetch('https://rest.nexmo.com/sms/json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: credentials.apiKey,
                api_secret: credentials.apiSecret,
                to: cleanTo,
                from: from.replace(/[^0-9]/g, ''),
                text: text
            })
        });
        
        const data = await response.json();
        
        if (data.messages && data.messages[0]) {
            const msg = data.messages[0];
            if (msg.status === '0') {
                res.json({
                    success: true,
                    to: cleanTo,
                    messageId: msg['message-id'],
                    status: 'sent'
                });
            } else {
                res.status(400).json({
                    error: msg['error-text'],
                    to: cleanTo,
                    status: 'failed',
                    errorCode: msg.status
                });
            }
        } else {
            res.status(500).json({ error: 'Unexpected response from Vonage', data });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// SDK-compatible endpoint at /sms/json
// This allows the Vonage Java SDK to work with just a base URL change
// Accepts the same format as https://rest.nexmo.com/sms/json
// Returns responses in Vonage API format so SDK can parse them
app.post('/sms/json', async (req, res) => {
    // Support both request credentials and configured credentials
    const configuredCreds = getActiveCredentials();
    const { api_key, api_secret, to, from, text } = req.body;
    
    // Use request credentials if provided, otherwise fall back to configured
    const credentials = {
        apiKey: api_key || configuredCreds.apiKey,
        apiSecret: api_secret || configuredCreds.apiSecret
    };
    
    if (!credentials.apiKey || !credentials.apiSecret) {
        // Return in Vonage error format
        return res.json({
            'message-count': '1',
            messages: [{
                status: '2',
                'error-text': 'Missing API credentials'
            }]
        });
    }
    
    if (!to || !from || !text) {
        return res.json({
            'message-count': '1',
            messages: [{
                status: '2',
                'error-text': 'Missing required fields: to, from, text'
            }]
        });
    }
    
    // Clean the "to" number
    const cleanTo = normalizeNumber(to);
    
    // Check if number is blocked
    const optouts = readJSON("optouts");
    const blocked = optouts.some(o => {
        const optoutNumber = normalizeNumber(typeof o === 'string' ? o : o.number);
        return optoutNumber === cleanTo;
    });
    
    if (blocked) {
        addLog(`Blocked SMS to ${cleanTo} - number is opted out`, 'warn');
        // Return in Vonage error format with custom status code 99 for opt-out
        return res.json({
            'message-count': '1',
            messages: [{
                to: cleanTo,
                status: '99',
                'error-text': 'Number is opted out'
            }]
        });
    }
    
    // Send via Vonage - forward to real API
    try {
        const response = await fetch('https://rest.nexmo.com/sms/json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: credentials.apiKey,
                api_secret: credentials.apiSecret,
                to: cleanTo,
                from: from,
                text: text
            })
        });
        
        const data = await response.json();
        
        // Log the send attempt
        if (data.messages && data.messages[0]) {
            const msg = data.messages[0];
            if (msg.status === '0') {
                addLog(`SMS sent to ${cleanTo} via /sms/json (SDK mode)`, 'info');
            } else {
                addLog(`SMS failed to ${cleanTo}: ${msg['error-text']}`, 'error');
            }
        }
        
        // Return the exact Vonage response - SDK expects this format
        res.json(data);
    } catch (error) {
        addLog(`SMS error: ${error.message}`, 'error');
        res.json({
            'message-count': '1',
            messages: [{
                status: '5',
                'error-text': error.message
            }]
        });
    }
});

// Bulk send SMS with blocklist checking
app.post('/api/send/bulk', async (req, res) => {
    const credentials = getActiveCredentials();
    
    if (!credentials.apiKey || !credentials.apiSecret) {
        return res.status(400).json({ error: 'API credentials not configured' });
    }
    
    const { recipients, from, text } = req.body;
    
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid recipients array' });
    }
    
    if (!from || !text) {
        return res.status(400).json({ error: 'Missing required fields: from, text' });
    }
    
    const optouts = readJSON("optouts");
    const results = {
        sent: [],
        blocked: [],
        failed: []
    };
    
    for (const recipient of recipients) {
        const cleanTo = normalizeNumber(recipient);
        
        if (!cleanTo) {
            results.failed.push({ to: recipient, error: 'Invalid number' });
            continue;
        }
        
        // Check if blocked
        const isBlocked = optouts.some(o => {
            const optoutNumber = normalizeNumber(typeof o === 'string' ? o : o.number);
            return optoutNumber === cleanTo;
        });
        
        if (isBlocked) {
            results.blocked.push({ to: cleanTo, reason: 'opted-out' });
            continue;
        }
        
        // Send via Vonage
        try {
            const response = await fetch('https://rest.nexmo.com/sms/json', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_key: credentials.apiKey,
                    api_secret: credentials.apiSecret,
                    to: cleanTo,
                    from: normalizeNumber(from),
                    text: text
                })
            });
            
            const data = await response.json();
            
            if (data.messages && data.messages[0]) {
                const msg = data.messages[0];
                if (msg.status === '0') {
                    results.sent.push({ to: cleanTo, messageId: msg['message-id'] });
                } else {
                    results.failed.push({ to: cleanTo, error: msg['error-text'], errorCode: msg.status });
                }
            } else {
                results.failed.push({ to: cleanTo, error: 'Unexpected response' });
            }
        } catch (error) {
            results.failed.push({ to: cleanTo, error: error.message });
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    res.json({
        summary: {
            total: recipients.length,
            sent: results.sent.length,
            blocked: results.blocked.length,
            failed: results.failed.length
        },
        results
    });
});

// Helper to normalize phone numbers for comparison
function normalizeNumber(num) {
    if (!num) return '';
    return num.replace(/[^0-9]/g, '');
}

// Shared handler for inbound SMS
function handleInboundSMS(req, res) {
    const rawData = req.method === 'GET' ? req.query : req.body;
    addLog(`WEBHOOK ${req.method} /webhooks/inbound-sms received`);
    addLog(`Raw data: ${JSON.stringify(rawData)}`);
    
    const config = readJSON("config");
    const optouts = readJSON("optouts");
    const history = readJSON("history");
    
    // Get data from query (GET) or body (POST)
    const data = rawData;
    
    const from = data.msisdn || data.from;
    const to = data.to;
    const text = (data.text || data.message || '').trim().toUpperCase();
    
    addLog(`Parsed: from=${from}, to=${to}, text="${text}"`);
    
    if (!from || !text) {
        addLog('Missing from or text - ignoring', 'warn');
        return res.sendStatus(200);
    }
    
    const timestamp = new Date().toISOString();
    const normalizedTo = normalizeNumber(to);
    const normalizedFrom = normalizeNumber(from);
    
    addLog(`Normalized: from=${normalizedFrom}, to=${normalizedTo}`);
    addLog(`Available configs: ${JSON.stringify(config.optoutConfigs.map(c => ({ number: c.optoutNumber, normalized: normalizeNumber(c.optoutNumber), phrase: c.optoutPhrase })))}`);
    
    // Find matching config for this number
    const matchingConfig = config.optoutConfigs.find(c => {
        const configNumber = normalizeNumber(c.optoutNumber);
        return configNumber === normalizedTo;
    });
    
    if (!matchingConfig) {
        addLog(`No config found for number ${to} (normalized: ${normalizedTo})`, 'warn');
        return res.sendStatus(200);
    }
    
    addLog(`Matched config: optoutPhrase="${matchingConfig.optoutPhrase}", optinPhrase="${matchingConfig.optinPhrase}"`);
    
    // Check if message matches opt-out phrase (flexible matching)
    const optoutPhrases = matchingConfig.optoutPhrase.toUpperCase().split(',').map(p => p.trim());
    const optinPhrases = matchingConfig.optinPhrase.toUpperCase().split(',').map(p => p.trim());
    
    addLog(`Checking "${text}" against optout phrases: ${JSON.stringify(optoutPhrases)}`);
    
    const isOptout = optoutPhrases.some(phrase => text === phrase || text.startsWith(phrase + ' '));
    const isOptin = optinPhrases.some(phrase => text === phrase || text.startsWith(phrase + ' '));
    
    if (isOptout) {
        // Add to opt-out list if not already there
        const optoutEntry = { number: normalizedFrom, configId: matchingConfig.id };
        const exists = optouts.some(o => normalizeNumber(typeof o === 'string' ? o : o.number) === normalizedFrom);
        if (!exists) {
            optouts.push(optoutEntry);
            writeJSON("optouts", optouts);
            addLog(`SUCCESS: Added ${normalizedFrom} to opt-out list`);
        } else {
            addLog(`${normalizedFrom} already in opt-out list`);
        }
        
        // Add to history
        history.push({
            number: normalizedFrom,
            action: 'optout',
            timestamp: timestamp,
            receivedOn: to,
            configId: matchingConfig.id
        });
        writeJSON("history", history);
    }
    // Check if message matches opt-in phrase
    else if (isOptin) {
        // Remove from opt-out list
        const index = optouts.findIndex(o => normalizeNumber(typeof o === 'string' ? o : o.number) === normalizedFrom);
        if (index > -1) {
            optouts.splice(index, 1);
            writeJSON("optouts", optouts);
            addLog(`SUCCESS: Removed ${normalizedFrom} from opt-out list`);
        }
        
        // Add to history
        history.push({
            number: normalizedFrom,
            action: 'optin',
            timestamp: timestamp,
            receivedOn: to,
            configId: matchingConfig.id
        });
        writeJSON("history", history);
    } else {
        addLog(`Message "${text}" does not match any opt-out/opt-in phrases`);
    }
    
    res.sendStatus(200);
}

// Handle incoming SMS webhook - using same path as working project
app.get('/webhooks/inbound-sms', handleInboundSMS);
app.post('/webhooks/inbound-sms', handleInboundSMS);

// Handle delivery receipts
app.post('/webhooks/status', (req, res) => {
    console.log('[STATUS] Delivery receipt:', req.body);
    res.sendStatus(200);
});

// Get all opted-out numbers
app.get('/api/optouts', (req, res) => {
    const optouts = readJSON("optouts");
    // Return just the numbers for backward compatibility
    const numbers = optouts.map(o => typeof o === 'string' ? o : o.number);
    res.json(numbers);
});

// Manual opt-out
app.post('/api/optout', (req, res) => {
    const { number } = req.body;
    const normalizedNum = normalizeNumber(number);
    const optouts = readJSON("optouts");
    const history = readJSON("history");
    
    const exists = optouts.some(o => normalizeNumber(typeof o === 'string' ? o : o.number) === normalizedNum);
    if (!exists) {
        optouts.push({ number: normalizedNum, configId: 'manual', originalNumber: number });
        writeJSON("optouts", optouts);
        
        history.push({
            number: normalizedNum,
            action: 'optout',
            timestamp: new Date().toISOString(),
            receivedOn: 'manual'
        });
        writeJSON("history", history);
    }
    
    res.json({ success: true });
});

// Manual opt-in
app.post('/api/optin', (req, res) => {
    const { number } = req.body;
    const normalizedNum = normalizeNumber(number);
    let optouts = readJSON("optouts");
    const history = readJSON("history");
    
    const index = optouts.findIndex(o => normalizeNumber(typeof o === 'string' ? o : o.number) === normalizedNum);
    if (index > -1) {
        optouts.splice(index, 1);
        writeJSON("optouts", optouts);
        
        history.push({
            number: normalizedNum,
            action: 'optin',
            timestamp: new Date().toISOString(),
            receivedOn: 'manual'
        });
        writeJSON("history", history);
    }
    
    res.json({ success: true });
});

// Bulk opt-out - add multiple numbers at once
app.post('/api/optout/bulk', (req, res) => {
    const { numbers } = req.body;
    
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid numbers array' });
    }
    
    const optouts = readJSON("optouts");
    const history = readJSON("history");
    const timestamp = new Date().toISOString();
    
    const results = {
        added: [],
        alreadyBlocked: []
    };
    
    for (const number of numbers) {
        const normalizedNum = normalizeNumber(number);
        if (!normalizedNum) continue;
        
        const exists = optouts.some(o => normalizeNumber(typeof o === 'string' ? o : o.number) === normalizedNum);
        if (!exists) {
            optouts.push({ number: normalizedNum, configId: 'api', originalNumber: number });
            history.push({
                number: normalizedNum,
                action: 'optout',
                timestamp: timestamp,
                receivedOn: 'api'
            });
            results.added.push(normalizedNum);
        } else {
            results.alreadyBlocked.push(normalizedNum);
        }
    }
    
    writeJSON("optouts", optouts);
    writeJSON("history", history);
    
    addLog(`Bulk opt-out: added ${results.added.length} numbers via API`);
    
    res.json({
        success: true,
        summary: {
            total: numbers.length,
            added: results.added.length,
            alreadyBlocked: results.alreadyBlocked.length
        },
        results
    });
});

// Bulk opt-in - remove multiple numbers at once
app.post('/api/optin/bulk', (req, res) => {
    const { numbers } = req.body;
    
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid numbers array' });
    }
    
    let optouts = readJSON("optouts");
    const history = readJSON("history");
    const timestamp = new Date().toISOString();
    
    const results = {
        removed: [],
        notFound: []
    };
    
    for (const number of numbers) {
        const normalizedNum = normalizeNumber(number);
        if (!normalizedNum) continue;
        
        const index = optouts.findIndex(o => normalizeNumber(typeof o === 'string' ? o : o.number) === normalizedNum);
        if (index > -1) {
            optouts.splice(index, 1);
            history.push({
                number: normalizedNum,
                action: 'optin',
                timestamp: timestamp,
                receivedOn: 'api'
            });
            results.removed.push(normalizedNum);
        } else {
            results.notFound.push(normalizedNum);
        }
    }
    
    writeJSON("optouts", optouts);
    writeJSON("history", history);
    
    addLog(`Bulk opt-in: removed ${results.removed.length} numbers via API`);
    
    res.json({
        success: true,
        summary: {
            total: numbers.length,
            removed: results.removed.length,
            notFound: results.notFound.length
        },
        results
    });
});

// ========== CONFIGURATION API ==========

// Get all configurations
app.get('/api/configs', (req, res) => {
    const config = readJSON("config");
    res.json(config.optoutConfigs || []);
});

// Add new configuration
app.post('/api/configs', (req, res) => {
    const { optoutNumber, optoutPhrase, optinPhrase } = req.body;
    
    if (!optoutNumber) {
        return res.status(400).json({ error: 'optoutNumber is required' });
    }
    
    const config = readJSON("config");
    const newConfig = {
        id: Date.now().toString(),
        optoutNumber: optoutNumber,
        optoutPhrase: optoutPhrase || 'STOP',
        optinPhrase: optinPhrase || 'START'
    };
    
    config.optoutConfigs.push(newConfig);
    writeJSON("config", config);
    
    addLog(`Config added via API: ${optoutNumber} with phrases ${optoutPhrase}/${optinPhrase}`);
    
    res.json({ success: true, config: newConfig });
});

// Update configuration
app.put('/api/configs/:id', (req, res) => {
    const { id } = req.params;
    const { optoutNumber, optoutPhrase, optinPhrase } = req.body;
    
    const config = readJSON("config");
    const index = config.optoutConfigs.findIndex(c => c.id === id);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Configuration not found' });
    }
    
    if (optoutNumber) config.optoutConfigs[index].optoutNumber = optoutNumber;
    if (optoutPhrase) config.optoutConfigs[index].optoutPhrase = optoutPhrase;
    if (optinPhrase) config.optoutConfigs[index].optinPhrase = optinPhrase;
    
    writeJSON("config", config);
    
    addLog(`Config ${id} updated via API`);
    
    res.json({ success: true, config: config.optoutConfigs[index] });
});

// Delete configuration
app.delete('/api/configs/:id', (req, res) => {
    const { id } = req.params;
    
    const config = readJSON("config");
    const initialLength = config.optoutConfigs.length;
    config.optoutConfigs = config.optoutConfigs.filter(c => c.id !== id);
    
    if (config.optoutConfigs.length === initialLength) {
        return res.status(404).json({ error: 'Configuration not found' });
    }
    
    writeJSON("config", config);
    
    addLog(`Config ${id} deleted via API`);
    
    res.json({ success: true });
});

// Get statistics for last 24 hours
app.get('/api/stats', (req, res) => {
    const history = readJSON("history");
    const now = new Date();
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
    
    const recentHistory = history.filter(item => 
        new Date(item.timestamp) >= twentyFourHoursAgo
    );
    
    const optins = recentHistory.filter(item => item.action === 'optin').length;
    const optouts = recentHistory.filter(item => item.action === 'optout').length;
    
    res.json({ optins, optouts });
});

// Get history with optional date filter
app.get('/api/history', (req, res) => {
    const { startDate, endDate, action } = req.query;
    let history = readJSON("history");
    
    if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        history = history.filter(item => new Date(item.timestamp) >= start);
    }
    
    if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        history = history.filter(item => new Date(item.timestamp) <= end);
    }
    
    if (action && action !== 'all') {
        history = history.filter(item => item.action === action);
    }
    
    // Sort by newest first
    history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    res.json(history);
});

// Clear history (optional admin function)
app.delete('/api/history', (req, res) => {
    writeJSON("history", []);
    res.json({ success: true });
});

const LISTEN_PORT = process.env.VCR_PORT || process.env.PORT || 3000;
const LISTEN_HOST = process.env.VCR_HOST || '0.0.0.0';

// Initialize storage and start server
async function startServer() {
    // Initialize persistent storage
    await initializeStorage();
    
    app.listen(LISTEN_PORT, LISTEN_HOST, () => {
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('              VONAGE OPT-OUT SYSTEM');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log(`Server: http://${LISTEN_HOST}:${LISTEN_PORT}`);
        console.log(`Environment: ${process.env.VCR_PORT ? 'VCR Cloud Runtime' : 'Local'}`);
        console.log(`Storage: ${IS_VCR && vcrState ? 'VCR Persistent State' : 'Local Files'}`);
        console.log(`Credentials: ${ENV_API_KEY ? 'From environment' : 'From file/UI'}`);
        
        const publicUrl = process.env.VCR_INSTANCE_PUBLIC_URL || `http://${LISTEN_HOST}:${LISTEN_PORT}`;
        const webhookUrl = `${publicUrl}/webhooks/inbound-sms`;
        
        if (process.env.VCR_INSTANCE_PUBLIC_URL) {
            console.log(`Public URL: ${process.env.VCR_INSTANCE_PUBLIC_URL}`);
            console.log(`Webhook URL: ${webhookUrl}`);
        }
        console.log('───────────────────────────────────────────────────────────────');
        console.log('Endpoints:');
        console.log('  POST /sms/json            - SDK-compatible send (Vonage format)');
        console.log('  POST /api/send            - Send single SMS');
        console.log('  POST /api/send/bulk       - Send bulk SMS');
        console.log('  GET  /api/check/:num      - Check if number blocked');
        console.log('  GET/POST /webhooks/inbound-sms - Inbound SMS webhook');
        console.log('  GET  /_/health            - Health check');
        console.log('═══════════════════════════════════════════════════════════════');
        
        // Add startup logs to in-memory logs
        addLog('Server started');
        addLog(`Storage: ${IS_VCR && vcrState ? 'VCR Persistent State (data will survive restarts)' : 'Local Files'}`);
        addLog(`Webhook URL: ${webhookUrl}`);
        addLog('Waiting for inbound SMS webhooks...');
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});
