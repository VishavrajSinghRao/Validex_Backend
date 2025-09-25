
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { v4 :uuidv4 } = require('uuid');
const redis = require('redis');
const crypto = require('crypto');
// require('dotenv').config();

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}


const app = express();
const PORT = process.env.PORT || 5000;

// Redis client setup
let redisClient;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
// const CACHE_EXPIRY = 24 * 60 * 60; // 24 hours in seconds
const CACHE_EXPIRY = 2 * 60; // 2 minutes in seconds

// Initialize Redis
async function initRedis() {
  try {
    redisClient = redis.createClient({
      url: REDIS_URL,
      retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          console.log('Redis server refused connection');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
          return new Error('Retry time exhausted');
        }
        if (options.attempt > 10) {
          return undefined;
        }
        return Math.min(options.attempt * 100, 3000);
      }
    });

    redisClient.on('error', (err) => {
      console.warn('Redis Client Error:', err.message);
    });

    redisClient.on('connect', () => {
      console.log('✅ Connected to Redis');
    });

    await redisClient.connect();
  } catch (error) {
    console.warn('⚠️ Redis connection failed, continuing without cache:', error.message);
    redisClient = null;
  }
}

// Cache helper functions
function generateCacheKey(url) {
  // Create a hash of the URL for consistent cache keys
  return `scrape:${crypto.createHash('md5').update(url).digest('hex')}`;
}

async function getCachedResult(url) {
  if (!redisClient) return null;

  try {
    const cacheKey = generateCacheKey(url);
    const cached = await redisClient.get(cacheKey);

    if (cached) {
      console.log(`📦 Cache hit for URL: ${url}`);
      return JSON.parse(cached);
    }

    console.log(`🔍 Cache miss for URL: ${url}`);
    return null;
  } catch (error) {
    console.warn('Cache read error:', error.message);
    return null;
  }
}
async function cleanupPythonScripts() {
  try {
    const scriptsDir = path.join(__dirname, 'python-scripts');
    const files = await fs.readdir(scriptsDir);

    for (const file of files) {
      if (file.startsWith('runner_')) {
        await fs.unlink(path.join(scriptsDir, file));
      }
    }
    console.log('Python scripts directory cleaned');
  } catch (error) {
    console.error('Error cleaning python scripts:', error);
  }
}

async function setCachedResult(url, result) {
  if (!redisClient) return;

  try {
    const cacheKey = generateCacheKey(url);
    await redisClient.setEx(cacheKey, CACHE_EXPIRY, JSON.stringify(result));
    console.log(`💾 Cached result for URL: ${url}`);
    await cleanupOldResults();
  } catch (error) {
    console.warn('Cache write error:', error.message);
  }
}

async function invalidateCache(url) {
  if (!redisClient) return;

  try {
    const cacheKey = generateCacheKey(url);
    await redisClient.del(cacheKey);
    console.log(`🗑️ Cache invalidated for URL: ${url}`);
  } catch (error) {
    console.warn('Cache invalidation error:', error.message);
  }
}

async function getCacheStats() {
  if (!redisClient) return { available: false };

  try {
    const info = await redisClient.info('memory');
    const keyCount = await redisClient.dbSize();

    return {
      available: true,
      keyCount,
      memoryUsage: info.split('\r\n').find(line => line.startsWith('used_memory_human:'))?.split(':')[1] || 'N/A'
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store active sessions
const activeSessions = new Map();

// Session class to track scraping progress
class ScrapingSession {
  constructor(sessionId, url) {
    this.sessionId = sessionId;
    this.url = url;
    this.status = 'initializing';
    this.progress = 0;
    this.result = null;
    this.error = null;
    this.startTime = new Date();
    this.logs = [];
    this.resultFilePath = null;
    this.fromCache = false; // Track if result came from cache
  }

  addLog(message) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      message: message
    };
    this.logs.push(logEntry);
    console.log(`[${this.sessionId}] ${message}`);
  }

  updateStatus(status, progress = null) {
    this.status = status;
    if (progress !== null) {
      this.progress = progress;
    }
    this.addLog(`Status: ${status} (${this.progress}%)`);
  }
}

// Create results directory if it doesn't exist
async function ensureResultsDir() {
  try {
    await fs.mkdir(path.join(__dirname, 'results'), { recursive: true });
    await fs.mkdir(path.join(__dirname, 'python-scripts'), { recursive: true });
  } catch (error) {
    console.error('Error creating directories:', error);
  }
}

// Function to find and read the latest result file for a session
async function findLatestResultFile(sessionId) {
  try {
    const resultsDir = path.join(__dirname, 'results');
    const files = await fs.readdir(resultsDir);

    // Look for files that might be related to this session
    // Check files from the last hour to find the most recent result
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const recentFiles = [];
    for (const file of files) {
      if (file.endsWith('.json') && file.includes('foscos_results_')) {
        const filePath = path.join(resultsDir, file);
        const stats = await fs.stat(filePath);

        if (stats.mtime > oneHourAgo) {
          recentFiles.push({
            name: file,
            path: filePath,
            mtime: stats.mtime
          });
        }
      }
    }

    // Sort by modification time (newest first)
    recentFiles.sort((a, b) => b.mtime - a.mtime);

    if (recentFiles.length > 0) {
      const content = await fs.readFile(recentFiles[0].path, 'utf-8');
      return JSON.parse(content);
    }

    return null;
  } catch (error) {
    console.error('Error reading result file:', error);
    return null;
  }
}

// Create a simplified Python runner script
async function createPythonRunner(sessionId, url) {
  const runnerScript = `
import sys
import os
import json
from datetime import datetime
import traceback

# Add the parent directory to path to import scraper
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, parent_dir)

try:
    # Import your existing scraper functions
    from scraper import extract_license_with_llm, automate_foscos_form
except ImportError as e:
    print(f"Import error: {e}")
    print("Please ensure scraper.py is in the parent directory")
    sys.exit(1)

def log_message(session_id, message):
    """Log message with session ID prefix"""
    print(f"[{session_id}] {message}")
    sys.stdout.flush()

def main():
    session_id = "${sessionId}"
    url = "${url}"
    
    try:
        log_message(session_id, "Starting extraction process...")
        log_message(session_id, f"Target URL: {url}")
        
        # Step 1: Extract license information
        log_message(session_id, "Step 1: Extracting license information...")
        license_result = extract_license_with_llm(url)
        
        if not license_result:
            raise Exception("Failed to extract license information")
        
        log_message(session_id, f"License extraction result: {json.dumps(license_result, indent=2)}")
        
        # Check if license number was found
        license_number = license_result.get("license_number")
        if not license_number or license_number.strip() == "":
            log_message(session_id, "No valid license number found")
            result = {
                "session_id": session_id,
                "url": url,
                "timestamp": datetime.now().isoformat(),
                "status": "partial_success",
                "license_extraction": license_result,
                "error": "No valid license number found",
                "foscos_result": None
            }
        else:
            log_message(session_id, f"Found license number: {license_number}")
            
            # Step 2: Run FoSCoS automation
            log_message(session_id, "Step 2: Starting FoSCoS automation...")
            
            try:
                # Call your existing automation function
                foscos_result = automate_foscos_form(license_number)
                
                result = {
                    "session_id": session_id,
                    "url": url,
                    "timestamp": datetime.now().isoformat(),
                    "status": "success",
                    "license_extraction": license_result,
                    "license_number": license_number,
                    "foscos_result": foscos_result
                }
                
                log_message(session_id, "FoSCoS automation completed successfully")
                
            except Exception as foscos_error:
                log_message(session_id, f"FoSCoS automation error: {str(foscos_error)}")
                result = {
                    "session_id": session_id,
                    "url": url,
                    "timestamp": datetime.now().isoformat(),
                    "status": "partial_success",
                    "license_extraction": license_result,
                    "license_number": license_number,
                    "foscos_error": str(foscos_error),
                    "foscos_result": None
                }
        
        # Output result as JSON for the Node.js process to capture
        print("===RESULT_START===")
        print(json.dumps(result, indent=2))
        print("===RESULT_END===")
        
        log_message(session_id, "Process completed successfully")
        
    except Exception as e:
        error_msg = str(e)
        error_trace = traceback.format_exc()
        
        log_message(session_id, f"Error occurred: {error_msg}")
        log_message(session_id, f"Traceback: {error_trace}")
        
        error_result = {
            "session_id": session_id,
            "url": url,
            "timestamp": datetime.now().isoformat(),
            "status": "error",
            "error": error_msg,
            "traceback": error_trace
        }
        
        print("===RESULT_START===")
        print(json.dumps(error_result, indent=2))
        print("===RESULT_END===")
        
        sys.exit(1)

if __name__ == "__main__":
    main()
`;

  const scriptPath = path.join(__dirname, 'python-scripts', `runner_${sessionId}.py`);
  await fs.writeFile(scriptPath, runnerScript, 'utf-8');
  return scriptPath;
}

async function cleanupOldResults() {
  try {
    const resultsDir = path.join(__dirname, 'results');
    const files = await fs.readdir(resultsDir);

    const resultFiles = files
      .filter(file => file.endsWith('.json') && file.includes('foscos_results_'))
      .map(file => ({
        name: file,
        path: path.join(resultsDir, file),
        mtime: require('fs').statSync(path.join(resultsDir, file)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);

    // Keep only 5 most recent files
    if (resultFiles.length > 5) {
      const filesToDelete = resultFiles.slice(5);
      for (const file of filesToDelete) {
        await fs.unlink(file.path);
        console.log(`Cleaned up old result file: ${file.name}`);
      }
    }
  } catch (error) {
    console.error('Error cleaning up old results:', error);
  }
}

// Enhanced Python script runner with cache check
async function runPythonScript(sessionId, url) {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  // Check cache first
  session.updateStatus('checking_cache', 5);
  const cachedResult = await getCachedResult(url);

  if (cachedResult) {
    session.addLog('Found cached result, skipping scraping');
    session.result = {
      ...cachedResult,
      fromCache: true,
      session_id: sessionId,
      cache_hit: true,
      timestamp: new Date().toISOString()
    };
    session.fromCache = true;
    session.updateStatus('completed', 100);
    return;
  }

  session.addLog('No cached result found, starting fresh scraping');
  let tempScriptPath = null;

  try {
    session.updateStatus('preparing', 10);

    // Create the Python runner script
    tempScriptPath = await createPythonRunner(sessionId, url);
    session.addLog(`Created Python runner script: ${tempScriptPath}`);

    session.updateStatus('starting_python', 15);

    // Determine Python command
    // Determine Python command - updated for Render
    const pythonCommand = process.env.PYTHON_PATH || process.env.NODE_ENV === 'production' ? 'python3' : 'python';

    session.addLog(`Using Python command: ${pythonCommand}`);
    session.addLog(`Script path: ${tempScriptPath}`);

    // Spawn Python process with proper environment
    const pythonProcess = spawn(pythonCommand, [tempScriptPath], {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONPATH: __dirname,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let outputBuffer = '';
    let errorBuffer = '';
    let resultCaptured = false;

    // Handle stdout
    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();
      outputBuffer += output;

      // Extract result from output
      const resultMatch = output.match(/===RESULT_START===([\s\S]*?)===RESULT_END===/);
      if (resultMatch && !resultCaptured) {
        resultCaptured = true;
        try {
          const resultJson = resultMatch[1].trim();
          const result = JSON.parse(resultJson);
          session.result = result;
          session.addLog("Result captured successfully");

          // Cache successful results
          if (result.status === 'success' || result.status === 'partial_success') {
            setCachedResult(url, result);
            session.addLog("Result cached for future requests");
          }

          if (result.status === 'error') {
            session.updateStatus('error', 100);
            session.error = result.error;
          } else {
            session.updateStatus('completed', 100);
          }
        } catch (parseError) {
          session.addLog(`Error parsing result JSON: ${parseError.message}`);
          session.updateStatus('error', 100);
          session.error = `Failed to parse result: ${parseError.message}`;
        }
      }

      // Log Python output and update progress
      const lines = output.split('\n').filter(line => line.trim());
      lines.forEach(line => {
        if (line.includes(`[${sessionId}]`)) {
          session.addLog(line);

          // Update progress based on log messages
          if (line.includes('Extracting license information')) {
            session.updateStatus('extracting_license', 25);
          } else if (line.includes('Starting FoSCoS automation')) {
            session.updateStatus('running_foscos', 40);
          } else if (line.includes('Navigating to FoSCoS website')) {
            session.updateStatus('navigating', 50);
          } else if (line.includes('Clicked search button')) {
            session.updateStatus('searching', 70);
          } else if (line.includes('View Products')) {
            session.updateStatus('extracting_products', 85);
          } else if (line.includes('Process completed')) {
            session.updateStatus('finalizing', 95);
          }
        }
      });
    });

    // Handle stderr
    pythonProcess.stderr.on('data', (data) => {
      const error = data.toString();
      errorBuffer += error;
      session.addLog(`Python Error: ${error.trim()}`);
    });

    // Handle process completion
    pythonProcess.on('close', async (code) => {
      try {
        // Clean up temporary script
        if (tempScriptPath) {
          await fs.unlink(tempScriptPath).catch(() => { });
          session.addLog("Temporary Python script cleaned up");
        }

        session.addLog(`Python process exited with code: ${code}`);

        if (code === 0 && resultCaptured) {
          // Success - result already captured and cached
          session.addLog("Process completed successfully");
        } else if (code === 0 && !resultCaptured) {
          // Success but no result captured - try to read from file
          session.addLog("No structured result captured, attempting to read from results file...");
          const fileResult = await findLatestResultFile(sessionId);

          if (fileResult) {
            session.addLog("Successfully loaded result from file");
            const result = {
              status: 'success',
              message: 'Results loaded from file',
              session_id: sessionId,
              url: url,
              timestamp: new Date().toISOString(),
              foscos_result: fileResult,
              license_extraction: {
                license_number: fileResult.source_license_number,
                manufacturer_name: fileResult.search_results?.[0]?.company_name
              }
            };
            session.result = result;

            // Cache the file result
            setCachedResult(url, result);
            session.addLog("File result cached for future requests");

            session.updateStatus('completed', 100);
          } else {
            session.updateStatus('completed_no_result', 100);
            session.result = {
              status: 'warning',
              message: 'Process completed but no structured result was captured',
              output: outputBuffer,
              logs: session.logs
            };
          }
        } else {
          // Process failed
          session.updateStatus('error', 100);
          session.error = `Python process failed with exit code ${code}`;
          session.result = {
            status: 'error',
            error: session.error,
            stderr: errorBuffer,
            stdout: outputBuffer,
            logs: session.logs
          };
        }
      } catch (error) {
        session.addLog(`Error in process cleanup: ${error.message}`);
        session.updateStatus('error', 100);
        session.error = error.message;
      }
    });

    // Handle process errors
    pythonProcess.on('error', async (error) => {
      session.addLog(`Process spawn error: ${error.message}`);
      session.updateStatus('error', 100);
      session.error = `Failed to start Python process: ${error.message}`;

      // Clean up on error
      if (tempScriptPath) {
        await fs.unlink(tempScriptPath).catch(() => { });
      }
    });

    // Set timeout for long-running processes (15 minutes)
    setTimeout(() => {
      if (session.status !== 'completed' && session.status !== 'error') {
        session.addLog('Process timeout reached');
        session.updateStatus('timeout', 100);
        session.error = 'Process timed out after 15 minutes';
        pythonProcess.kill('SIGTERM');
      }
    }, 15 * 60 * 1000);

  } catch (error) {
    session.addLog(`Error in runPythonScript: ${error.message}`);
    session.updateStatus('error', 100);
    session.error = error.message;

    // Clean up on error
    if (tempScriptPath) {
      await fs.unlink(tempScriptPath).catch(() => { });
    }
  }
}

// Routes

// Start scraping
app.post('/api/scrape', async (req, res) => {
  try {
    const { url, skipCache = false } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const sessionId = uuidv4();
    const session = new ScrapingSession(sessionId, url);

    activeSessions.set(sessionId, session);
    session.addLog(`New scraping session created for URL: ${url}`);

    // If skipCache is requested, invalidate existing cache
    if (skipCache) {
      await invalidateCache(url);
      session.addLog('Cache invalidated as requested');
    }

    // Start scraping in background
    runPythonScript(sessionId, url).catch(error => {
      console.error(`Error in background scraping for ${sessionId}:`, error);
      session.updateStatus('error', 100);
      session.error = error.message;
    });

    res.json({
      sessionId,
      status: 'started',
      message: 'Scraping process initiated successfully',
      url: url,
      cacheEnabled: !!redisClient
    });

  } catch (error) {
    console.error('Error starting scraping:', error);
    res.status(500).json({ error: 'Failed to start scraping process' });
  }
});

// Get session status
app.get('/api/status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // If session is completed but no result, try to load from file
  if (session.status === 'completed_no_result' || !session.result?.foscos_result) {
    const fileResult = await findLatestResultFile(sessionId);
    if (fileResult) {
      session.result = {
        status: 'success',
        message: 'Results loaded from file',
        session_id: sessionId,
        url: session.url,
        timestamp: new Date().toISOString(),
        foscos_result: fileResult,
        license_extraction: {
          license_number: fileResult.source_license_number,
          manufacturer_name: fileResult.search_results?.[0]?.company_name
        }
      };
      session.status = 'completed';
      session.addLog("Results loaded from file");
    }
  }

  // Calculate duration
  const duration = new Date() - session.startTime;

  res.json({
    sessionId: session.sessionId,
    url: session.url,
    status: session.status,
    progress: session.progress,
    result: session.result,
    error: session.error,
    startTime: session.startTime,
    duration: Math.round(duration / 1000), // in seconds
    logCount: session.logs.length,
    logs: session.logs.slice(-10), // Return last 10 logs
    fromCache: session.fromCache || session.result?.fromCache || false
  });
});

// Get full logs for a session
app.get('/api/logs/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    sessionId: session.sessionId,
    logs: session.logs
  });
});

// Get cache statistics
app.get('/api/cache/stats', async (req, res) => {
  try {
    const stats = await getCacheStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting cache stats:', error);
    res.status(500).json({ error: 'Failed to get cache statistics' });
  }
});

// Clear cache for a specific URL
app.delete('/api/cache/:url', async (req, res) => {
  try {
    const { url } = req.params;
    const decodedUrl = decodeURIComponent(url);
    await invalidateCache(decodedUrl);
    res.json({ message: 'Cache cleared successfully', url: decodedUrl });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Clear all cache
app.delete('/api/cache', async (req, res) => {
  try {
    if (!redisClient) {
      return res.status(503).json({ error: 'Cache not available' });
    }

    await redisClient.flushDb();
    res.json({ message: 'All cache cleared successfully' });
  } catch (error) {
    console.error('Error clearing all cache:', error);
    res.status(500).json({ error: 'Failed to clear all cache' });
  }
});

// Get latest result file
app.get('/api/results/latest', async (req, res) => {
  try {
    const result = await findLatestResultFile('latest');
    if (result) {
      res.json(result);
    } else {
      res.status(404).json({ error: 'No recent results found' });
    }
  } catch (error) {
    console.error('Error reading latest result:', error);
    res.status(500).json({ error: 'Failed to read result file' });
  }
});

// Get all result files
app.get('/api/results', async (req, res) => {
  try {
    const resultsDir = path.join(__dirname, 'results');
    const files = await fs.readdir(resultsDir);

    const resultFiles = [];
    for (const file of files) {
      if (file.endsWith('.json') && file.includes('foscos_results_')) {
        const filePath = path.join(resultsDir, file);
        const stats = await fs.stat(filePath);

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const data = JSON.parse(content);
          resultFiles.push({
            filename: file,
            created: stats.mtime,
            size: stats.size,
            source_license: data.source_license_number,
            company: data.search_results[0]?.company_name || 'N/A',
            status: data.search_results[0]?.status || 'N/A',
            products_count: data.product_details?.products?.length || 0
          });
        } catch (parseError) {
          console.error(`Error parsing ${file}:`, parseError);
        }
      }
    }

    // Sort by creation time (newest first)
    resultFiles.sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({
      total: resultFiles.length,
      files: resultFiles
    });
  } catch (error) {
    console.error('Error reading results directory:', error);
    res.status(500).json({ error: 'Failed to read results directory' });
  }
});

// Get specific result file by filename
app.get('/api/results/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(__dirname, 'results', filename);

    // Security check - ensure filename only contains safe characters
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);

    res.json(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'Result file not found' });
    } else {
      console.error('Error reading result file:', error);
      res.status(500).json({ error: 'Failed to read result file' });
    }
  }
});

// Get all active sessions
app.get('/api/sessions', (req, res) => {
  const sessions = Array.from(activeSessions.values()).map(session => ({
    sessionId: session.sessionId,
    url: session.url,
    status: session.status,
    progress: session.progress,
    startTime: session.startTime,
    duration: Math.round((new Date() - session.startTime) / 1000),
    hasResult: !!session.result,
    hasError: !!session.error,
    fromCache: session.fromCache
  }));

  res.json({
    sessions,
    totalSessions: sessions.length
  });
});

// Delete session
app.delete('/api/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const deleted = activeSessions.delete(sessionId);

  if (deleted) {
    res.json({ message: 'Session deleted successfully' });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  const cacheStats = await getCacheStats();

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
    serverUptime: process.uptime(),
    nodeVersion: process.version,
    cache: cacheStats
  });
});

// Serve a simple frontend for testing
app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Product License Scraper (with Redis Cache)</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        .container { background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .cache-info { background: #e3f2fd; padding: 15px; border-radius: 8px; margin: 10px 0; }
        input[type="text"] { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; }
        input[type="checkbox"] { margin: 0 5px; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; margin: 5px; }
        button:hover { background: #0056b3; }
        button.danger { background: #dc3545; }
        button.danger:hover { background: #c82333; }
        .status { margin: 10px 0; padding: 10px; border-radius: 4px; }
        .status.success { background: #d4edda; color: #155724; }
        .status.error { background: #f8d7da; color: #721c24; }
        .status.running { background: #d1ecf1; color: #0c5460; }
        .status.cache { background: #fff3cd; color: #856404; }
        .logs { background: #f8f9fa; padding: 10px; border-radius: 4px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 12px; }
    </style>
</head>
<body>
    <h1>Product License Scraper (with Redis Cache)</h1>
    
    <div class="cache-info" id="cacheInfo">
        <h3>Cache Status</h3>
        <div id="cacheStatus">Loading cache status...</div>
        <button onclick="loadCacheStats()">Refresh Cache Stats</button>
        <button onclick="clearAllCache()" class="danger">Clear All Cache</button>
    </div>
    
    <div class="container">
        <h3>Start Scraping</h3>
        <input type="text" id="urlInput" placeholder="Enter product URL (e.g., https://www.avvatarindia.com/product/alpha-whey-belgian-chocolate-flavour-2-kg)" />
        <div>
            <input type="checkbox" id="skipCache" />
            <label for="skipCache">Skip cache (force fresh scraping)</label>
        </div>
        <button onclick="startScraping()">Start Scraping</button>
        <button onclick="loadLatestResult()">Load Latest Result</button>
    </div>
    
    <div id="status" class="container" style="display: none;">
        <h3>Status</h3>
        <div id="statusContent"></div>
        <div id="progressBar" style="background: #e9ecef; border-radius: 4px; overflow: hidden; margin: 10px 0;">
            <div id="progressFill" style="height: 20px; background: #007bff; width: 0%; transition: width 0.3s;"></div>
        </div>
        <button onclick="checkStatus()">Refresh Status</button>
        <button onclick="clearUrlCache()" class="danger">Clear URL Cache</button>
    </div>
    
    <div id="logs" class="container" style="display: none;">
        <h3>Logs</h3>
        <div id="logsContent" class="logs"></div>
    </div>

    <script>
        let currentSessionId = null;
        let currentUrl = null;
        let statusInterval = null;

        // Load cache stats on page load
        window.onload = function() {
            loadCacheStats();
        };

        async function loadCacheStats() {
            try {
                const response = await fetch('/api/cache/stats');
                const stats = await response.json();
                
                const statusDiv = document.getElementById('cacheStatus');
                
                if (stats.available) {
                    statusDiv.innerHTML = \`
                        <strong>✅ Redis Cache Available</strong><br>
                        <strong>Cached Keys:</strong> \${stats.keyCount}<br>
                        <strong>Memory Usage:</strong> \${stats.memoryUsage}
                    \`;
                } else {
                    statusDiv.innerHTML = \`
                        <strong>❌ Redis Cache Unavailable</strong><br>
                        Error: \${stats.error || 'Redis connection failed'}
                    \`;
                }
            } catch (error) {
                document.getElementById('cacheStatus').innerHTML = \`
                    <strong>❌ Cache Status Error</strong><br>
                    Error: \${error.message}
                \`;
            }
        }

        async function startScraping() {
            const url = document.getElementById('urlInput').value.trim();
            const skipCache = document.getElementById('skipCache').checked;
            
            if (!url) {
                alert('Please enter a URL');
                return;
            }

            currentUrl = url;

            try {
                const response = await fetch('/api/scrape', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, skipCache })
                });

                const result = await response.json();
                
                if (result.sessionId) {
                    currentSessionId = result.sessionId;
                    document.getElementById('status').style.display = 'block';
                    document.getElementById('logs').style.display = 'block';
                    
                    // Start checking status every 2 seconds
                    if (statusInterval) clearInterval(statusInterval);
                    statusInterval = setInterval(checkStatus, 2000);
                    
                    checkStatus();
                } else {
                    alert('Error: ' + (result.error || 'Unknown error'));
                }
            } catch (error) {
                alert('Network error: ' + error.message);
            }
        }

        async function loadLatestResult() {
            try {
                const response = await fetch('/api/results/latest');
                const result = await response.json();
                
                document.getElementById('status').style.display = 'block';
                const statusContent = document.getElementById('statusContent');
                
                statusContent.innerHTML = \`
                    <div class="status success">
                        <strong>Latest Result Loaded</strong><br>
                        <strong>Company:</strong> \${result.search_results?.[0]?.company_name}<br>
                        <strong>License:</strong> \${result.source_license_number}<br>
                        <strong>Products:</strong> \${result.product_details?.products?.length || 0}<br>
                        <pre>\${JSON.stringify(result, null, 2)}</pre>
                    </div>
                \`;
            } catch (error) {
                alert('Error loading latest result: ' + error.message);
            }
        }

        async function clearUrlCache() {
            if (!currentUrl) {
                alert('No URL to clear cache for');
                return;
            }

            try {
                const response = await fetch(\`/api/cache/\${encodeURIComponent(currentUrl)}\`, {
                    method: 'DELETE'
                });

                const result = await response.json();
                alert('Cache cleared for current URL');
                loadCacheStats();
            } catch (error) {
                alert('Error clearing URL cache: ' + error.message);
            }
        }

        async function clearAllCache() {
            if (!confirm('Are you sure you want to clear all cache?')) {
                return;
            }

            try {
                const response = await fetch('/api/cache', {
                    method: 'DELETE'
                });

                const result = await response.json();
                alert('All cache cleared successfully');
                loadCacheStats();
            } catch (error) {
                alert('Error clearing all cache: ' + error.message);
            }
        }

        async function checkStatus() {
            if (!currentSessionId) return;

            try {
                const response = await fetch('/api/status/' + currentSessionId);
                const status = await response.json();

                // Update status display
                const statusContent = document.getElementById('statusContent');
                const progressFill = document.getElementById('progressFill');
                const logsContent = document.getElementById('logsContent');

                const cacheIndicator = status.fromCache ? '<span class="status cache">📦 FROM CACHE</span>' : '';

                statusContent.innerHTML = \`
                    <div class="status \${status.status === 'completed' ? 'success' : status.status === 'error' ? 'error' : 'running'}">
                        <strong>Status:</strong> \${status.status} \${cacheIndicator}<br>
                        <strong>Progress:</strong> \${status.progress}%<br>
                        <strong>Duration:</strong> \${status.duration}s<br>
                        \${status.error ? '<strong>Error:</strong> ' + status.error + '<br>' : ''}
                        \${status.result ? '<strong>Result:</strong> <pre>' + JSON.stringify(status.result, null, 2) + '</pre>' : ''}
                    </div>
                \`;

                progressFill.style.width = status.progress + '%';

                // Update logs
                if (status.logs) {
                    logsContent.innerHTML = status.logs.map(log => 
                        \`<div>[\${new Date(log.timestamp).toLocaleTimeString()}] \${log.message}</div>\`
                    ).join('');
                    logsContent.scrollTop = logsContent.scrollHeight;
                }

                // Stop polling if completed or error
                if (status.status === 'completed' || status.status === 'error') {
                    if (statusInterval) {
                        clearInterval(statusInterval);
                        statusInterval = null;
                    }
                    
                    // Refresh cache stats after completion
                    loadCacheStats();
                }

            } catch (error) {
                console.error('Error checking status:', error);
            }
        }
    </script>
</body>
</html>
  `;

  res.send(html);
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// Cleanup function
function cleanup() {
  console.log('\nCleaning up...');
  activeSessions.clear();

  if (redisClient) {
    redisClient.disconnect();
  }

  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Initialize and start server
async function startServer() {
  try {
    await ensureResultsDir();
    await initRedis();
    setInterval(cleanupPythonScripts, 60000);

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🌐 Test interface: http://localhost:${PORT}`);
      console.log(`📁 Make sure your scraper.py file is in the same directory as this server file`);
      console.log(`💾 Redis cache: ${redisClient ? 'Connected' : 'Disabled'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();