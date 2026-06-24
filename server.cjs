const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const net = require('net');
const http = require('http');
const https = require('https');

const app = express();
const PORT = 3000;

// 获取 exe 所在目录（pkg 打包后使用 process.execPath）
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const SCRIPTS_DIR = path.join(BASE_DIR, 'scripts');
const CONFIG_FILE = path.join(SCRIPTS_DIR, '.scripts.json');
const CRON_FILE = path.join(SCRIPTS_DIR, '.cron.json');
const SETTINGS_FILE = path.join(SCRIPTS_DIR, '.settings.json');
const LOGS_FILE = path.join(SCRIPTS_DIR, '.logs.json');

const cronJobs = {};
const runningProcesses = {};

app.use(express.json());
app.use(express.static(BASE_DIR));

// 文件下载路由 - 从 static/uploads 目录下载文件
app.get('/download/*', (req, res) => {
  try {
    const filePath = req.params[0];
    const fullPath = path.join(BASE_DIR, 'static', 'uploads', filePath);
    const decodedPath = decodeURIComponent(fullPath);
    
    // 安全检查：确保文件在 uploads 目录内
    const uploadsDir = path.join(BASE_DIR, 'static', 'uploads');
    const resolvedPath = path.resolve(decodedPath);
    
    if (!resolvedPath.startsWith(path.resolve(uploadsDir))) {
      return res.status(403).json({ error: '禁止访问此路径' });
    }
    
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: '文件不存在' });
    }
    
    const fileName = path.basename(decodedPath);
    const ext = fileName.split('.').pop().toLowerCase();
    
    // 设置正确的MIME类型和下载头
    const mimeTypes = {
      'apk': 'application/vnd.android.package-archive',
      'exe': 'application/octet-stream',
      'zip': 'application/zip',
      'rar': 'application/vnd.rar',
      '7z': 'application/x-7z-compressed',
      'tar': 'application/x-tar',
      'gz': 'application/gzip',
      'iso': 'application/iso9660',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ppt': 'application/vnd.ms-powerpoint',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'bmp': 'image/bmp',
      'svg': 'image/svg+xml',
      'webp': 'image/webp',
      'mp4': 'video/mp4',
      'avi': 'video/x-msvideo',
      'mkv': 'video/x-matroska',
      'mov': 'video/quicktime',
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'flac': 'audio/flac'
    };
    
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const encodedFileName = encodeURIComponent(fileName);
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`);
    res.setHeader('Content-Length', fs.statSync(resolvedPath).size);
    
    const fileStream = fs.createReadStream(resolvedPath);
    fileStream.pipe(res);
    
  } catch (err) {
    console.error(`[DOWNLOAD ERROR] ${err.message}`);
    res.status(500).json({ error: '下载失败', details: err.message });
  }
});

// 获取 uploads 目录下的文件列表
app.get('/api/uploads', (req, res) => {
  try {
    const uploadsDir = path.join(BASE_DIR, 'static', 'uploads');
    
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      return res.json([]);
    }
    
    const files = fs.readdirSync(uploadsDir)
      .filter(file => {
        const fullPath = path.join(uploadsDir, file);
        return fs.statSync(fullPath).isFile();
      })
      .map(file => {
        const fullPath = path.join(uploadsDir, file);
        const stats = fs.statSync(fullPath);
        return {
          name: file,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          downloadUrl: `/download/${file}`
        };
      });
    
    res.json(files);
  } catch (err) {
    console.error(`[UPLOADS ERROR] ${err.message}`);
    res.status(500).json({ error: '获取文件列表失败', details: err.message });
  }
});

function checkPortAvailable(port, callback) {
  const server = net.createServer();
  server.once('error', (err) => {
    callback(err.code === 'EADDRINUSE');
  });
  server.once('listening', () => {
    server.close();
    callback(false);
  });
  server.listen(port);
}

function openBrowser(url) {
  const platform = process.platform;
  let command;
  if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  exec(command, (err) => {
    if (err) {
      console.error('打开浏览器失败:', err.message);
    }
  });
}

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {}
  return { scripts: [] };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getCronConfig() {
  try {
    if (fs.existsSync(CRON_FILE)) {
      return JSON.parse(fs.readFileSync(CRON_FILE, 'utf8'));
    }
  } catch (err) {}
  return { tasks: [] };
}

function saveCronConfig(config) {
  fs.writeFileSync(CRON_FILE, JSON.stringify(config, null, 2));
}

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return {
        pythonEnvs: settings.pythonEnvs || [],
        cronExpressions: settings.cronExpressions || getDefaultCronExpressions()
      };
    }
  } catch (err) {}
  return { pythonEnvs: [], cronExpressions: getDefaultCronExpressions() };
}

function saveSettings(config) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(config, null, 2));
}

app.get('/api/settings', (req, res) => {
  try {
    res.json(getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const { pythonEnvs, cronExpressions } = req.body;
    saveSettings({ 
      pythonEnvs: pythonEnvs || [], 
      cronExpressions: cronExpressions || getDefaultCronExpressions()
    });
    res.json({ success: true, message: '设置已保存' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 默认常用Cron表达式
function getDefaultCronExpressions() {
  return [
    { expression: '0 0 0 * * *', description: '每天凌晨0点执行' },
    { expression: '0 0 2 * * *', description: '每天凌晨2点执行' },
    { expression: '0 0 6 * * *', description: '每天早上6点执行' },
    { expression: '0 0 9 * * *', description: '每天上午9点执行' },
    { expression: '0 0 12 * * *', description: '每天中午12点执行' },
    { expression: '0 0 18 * * *', description: '每天下午6点执行' },
    { expression: '0 0 22 * * *', description: '每天晚上10点执行' },
    { expression: '0 30 9 * * *', description: '每天上午9:30执行' },
    { expression: '0 0 9 * * 1-5', description: '周一到周五上午9点执行' },
    { expression: '0 0 0 * * 0', description: '每周日凌晨0点执行' },
    { expression: '0 0 0 1 * *', description: '每月1日凌晨0点执行' },
    { expression: '0 */30 * * * *', description: '每30分钟执行一次' },
    { expression: '0 */1 * * * *', description: '每小时执行一次' },
    { expression: '0 */2 * * * *', description: '每2小时执行一次' },
    { expression: '0 */6 * * * *', description: '每6小时执行一次' }
  ];
}

// 日志 API
function getLogs() {
  try {
    if (fs.existsSync(LOGS_FILE)) {
      return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    }
  } catch (err) {}
  return [];
}

function saveLogs(logs) {
  fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
}

app.get('/api/logs', (req, res) => {
  res.json(getLogs());
});

app.post('/api/logs/clear', (req, res) => {
  try {
    saveLogs([]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scripts', (req, res) => {
  try {
    if (!fs.existsSync(SCRIPTS_DIR)) {
      fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
    }
    const config = getConfig();
    res.json(config.scripts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browse-files', (req, res) => {
  try {
    const { dirPath } = req.body;
    let targetDir = dirPath || process.cwd();
    
    if (!fs.existsSync(targetDir)) {
      targetDir = process.cwd();
    }
    
    const items = fs.readdirSync(targetDir, { withFileTypes: true });
    const result = items.map(item => ({
      name: item.name,
      isDirectory: item.isDirectory(),
      isFile: item.isFile(),
      fullPath: path.join(targetDir, item.name),
      extension: item.isFile() ? item.name.split('.').pop().toLowerCase() : ''
    }));
    
    res.json({ 
      success: true, 
      currentPath: targetDir,
      parentPath: path.dirname(targetDir) !== targetDir ? path.dirname(targetDir) : null,
      items: result 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/get-drives', (req, res) => {
  try {
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const drive = String.fromCharCode(i) + ':';
      if (fs.existsSync(drive)) {
        drives.push({ name: drive, fullPath: drive + '\\', isDirectory: true });
      }
    }
    res.json({ success: true, drives });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/run', (req, res) => {
  const { scriptPath, pythonEnv } = req.body;
  console.log(`[RUN REQUEST] scriptPath=${scriptPath}, pythonEnv=${pythonEnv}`);
  console.log(`[RUN REQUEST] body=${JSON.stringify(req.body)}`);
  
  if (!scriptPath) {
    console.error(`[ERROR] 缺少脚本路径`);
    return res.status(400).json({ error: '缺少脚本路径' });
  }
  
  const config = getConfig();
  console.log(`[DEBUG] 所有脚本: ${JSON.stringify(config.scripts.map(s => ({id: s.id, name: s.name, path: s.path, pythonEnv: s.pythonEnv})))}`);
  
  const script = config.scripts.find(s => s.id === scriptPath);
  
  if (!script) {
    console.error(`[ERROR] 脚本不存在: ${scriptPath}`);
    return res.status(404).json({ error: '脚本不存在', details: `找不到 id 为 ${scriptPath} 的脚本` });
  }
  
  if (runningProcesses[scriptPath]) {
    return res.status(400).json({ error: '脚本正在运行中，请先停止' });
  }
  
  const fullPath = script.path;
  const ext = script.ext;
  const env = pythonEnv || script.pythonEnv || 'python';
  
  console.log(`[DEBUG] 找到脚本: ${JSON.stringify(script)}`);
  console.log(`[DEBUG] 脚本完整路径: ${fullPath}`);
  console.log(`[DEBUG] 脚本扩展名: ${ext}`);
  console.log(`[DEBUG] 使用Python环境: ${env}`);
  console.log(`[DEBUG] 文件是否存在: ${fs.existsSync(fullPath)}`);
  
  let command, args;
  
  switch (ext) {
    case 'ps1':
      command = 'powershell';
      args = ['-ExecutionPolicy', 'Bypass', '-File', `"${fullPath}"`];
      break;
    case 'py':
      command = env;
      args = ['-u', `"${fullPath}"`];
      break;
    case 'js':
    case 'mjs':
    case 'cjs':
      command = 'node';
      args = [`"${fullPath}"`];
      break;
    case 'bat':
    case 'cmd':
      command = 'cmd';
      args = ['/c', `"${fullPath}"`];
      break;
    case 'exe':
      command = fullPath;
      args = [];
      break;
    case 'sh':
      command = 'powershell';
      args = ['-ExecutionPolicy', 'Bypass', '-Command', `& "${fullPath}"`];
      break;
    case 'rb':
      command = 'ruby';
      args = [`"${fullPath}"`];
      break;
    case 'php':
      command = 'php';
      args = [`"${fullPath}"`];
      break;
    case 'pl':
      command = 'perl';
      args = [`"${fullPath}"`];
      break;
    case 'vbs':
      command = 'cscript';
      args = ['//nologo', `"${fullPath}"`];
      break;
    default:
      console.error(`[ERROR] 不支持的脚本类型: ${ext}`);
      return res.status(400).json({ error: '不支持的脚本类型' });
  }
  
  console.log(`[DEBUG] 执行命令: ${command} ${args.join(' ')}`);
  
  const processEnv = { 
    ...process.env, 
    PYTHONIOENCODING: 'utf-8', 
    PYTHONUTF8: '1',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    CPATH: 'utf-8',
    CMD_UTF8: '1'
  };
  
  // 设置工作目录为脚本所在目录，确保相对路径正确解析
  const scriptDir = path.dirname(fullPath);
  
  const child = spawn(command, args, { 
    env: processEnv,
    windowsHide: true,
    shell: true,
    cwd: scriptDir
  });
  
  const runId = Date.now().toString();
  runningProcesses[scriptPath] = {
    process: child,
    runId: runId,
    startTime: new Date().toISOString(),
    stdout: '',
    stderr: ''
  };
  
  child.stdout.on('data', (data) => {
    const output = data.toString('utf-8');
    runningProcesses[scriptPath].stdout += output;
    console.log(`[STDOUT] ${output}`);
  });
  
  child.stderr.on('data', (data) => {
    const output = data.toString('utf-8');
    runningProcesses[scriptPath].stderr += output;
    console.error(`[STDERR] ${output}`);
  });
  
  let logSaved = false;
  
  child.on('close', (code, signal) => {
    const procInfo = runningProcesses[scriptPath];
    const exitCode = code !== null ? code : signal ? -1 : null;
    const success = exitCode === 0;
    
    const stdout = procInfo ? procInfo.stdout || '' : '';
    const stderr = procInfo ? procInfo.stderr || '' : '';
    const output = (stdout + stderr).trim() || '无输出';
    
    const logs = getLogs();
    logs.push({
      scriptId: script.id,
      scriptName: script.name,
      timestamp: new Date().toISOString(),
      success: success,
      exitCode: exitCode,
      output: output
    });
    if (logs.length > 100) {
      logs.splice(0, logs.length - 100);
    }
    saveLogs(logs);
    logSaved = true;
    
    delete runningProcesses[scriptPath];
    
    if (code !== 0) {
      console.error(`[ERROR] 执行失败，退出码: ${code}, 信号: ${signal}`);
    } else {
      console.log(`[DEBUG] 执行成功`);
    }
  });
  
  setTimeout(() => {
    const procInfo = runningProcesses[scriptPath];
    if (!procInfo || logSaved) return;
    
    const stdout = procInfo.stdout || '';
    const stderr = procInfo.stderr || '';
    const output = (stdout + stderr).trim() || '脚本已启动，正在运行中...';
    
    const logs = getLogs();
    logs.push({
      scriptId: script.id,
      scriptName: script.name,
      timestamp: new Date().toISOString(),
      success: true,
      exitCode: null,
      output: output
    });
    if (logs.length > 100) {
      logs.splice(0, logs.length - 100);
    }
    saveLogs(logs);
  }, 2000);
  
  res.json({ 
    success: true, 
    message: '脚本已启动',
    runId: runId
  });
});

app.post('/api/stop', (req, res) => {
  const { scriptPath } = req.body;
  
  if (!scriptPath) {
    return res.status(400).json({ error: '缺少脚本路径' });
  }
  
  if (!runningProcesses[scriptPath]) {
    return res.status(400).json({ error: '脚本未在运行' });
  }
  
  const procInfo = runningProcesses[scriptPath];
  const child = procInfo.process;
  
  try {
    // Windows 下使用 taskkill 强制终止进程树
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${child.pid} /T /F`, (err) => {
        if (err) {
          console.error(`[ERROR] taskkill 失败: ${err.message}`);
          // 尝试普通 kill
          child.kill('SIGKILL');
        }
      });
    } else {
      child.kill('SIGKILL');
    }
    
    delete runningProcesses[scriptPath];
    
    const config = getConfig();
    const script = config.scripts.find(s => s.id === scriptPath);
    
    const logs = getLogs();
    logs.push({
      scriptId: script ? script.id : scriptPath,
      scriptName: script ? script.name : '未知脚本',
      timestamp: new Date().toISOString(),
      success: false,
      exitCode: -1,
      output: '脚本已被手动停止'
    });
    if (logs.length > 100) {
      logs.splice(0, logs.length - 100);
    }
    saveLogs(logs);
    
    console.log(`[STOP] 脚本 ${script ? script.name : scriptPath} 已被手动停止`);
    res.json({ success: true, message: '脚本已停止' });
  } catch (err) {
    console.error(`[ERROR] 停止脚本失败: ${err.message}`);
    res.status(500).json({ error: '停止脚本失败', details: err.message });
  }
});

app.get('/api/running', (req, res) => {
  const running = Object.keys(runningProcesses).map(scriptId => {
    const procInfo = runningProcesses[scriptId];
    return {
      scriptId: scriptId,
      scriptPath: scriptId, // 保持兼容性
      runId: procInfo.runId,
      startTime: procInfo.startTime
    };
  });
  res.json({ success: true, data: running });
});

app.post('/api/delete', (req, res) => {
  const { scriptPath } = req.body;
  if (!scriptPath) {
    return res.status(400).json({ error: '缺少脚本路径' });
  }
  
  try {
    const config = getConfig();
    const scriptIndex = config.scripts.findIndex(s => s.id === scriptPath);
    
    if (scriptIndex === -1) {
      return res.status(404).json({ error: '脚本不存在' });
    }
    
    const script = config.scripts[scriptIndex];
    
    if (fs.existsSync(script.path)) {
      fs.unlinkSync(script.path);
    }
    
    config.scripts.splice(scriptIndex, 1);
    saveConfig(config);
    
    res.json({ success: true, message: `已删除: ${script.name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create', (req, res) => {
  const { name, ext, folderPath, pythonEnv, description } = req.body;
  if (!name) {
    return res.status(400).json({ error: '缺少脚本名称' });
  }
  
  let finalExt = ext || 'ps1';
  // 去除用户输入的名称可能带的后缀
  let scriptName = name.replace(/\.[^.]+$/, '');
  let fileName = `${scriptName}.${finalExt}`;
  let fullPath;
  
  if (folderPath && (folderPath.startsWith('\\') || folderPath.match(/^[A-Za-z]:/))) {
      // 绝对路径
      const extPattern = new RegExp(`\\.(${['ps1', 'py', 'js', 'bat', 'cmd', 'exe', 'sh', 'rb', 'php', 'pl', 'vbs', 'mjs', 'cjs'].join('|')})$`, 'i');
      if (extPattern.test(folderPath)) {
      // 用户输入的是完整文件路径
      fullPath = folderPath;
      // 使用用户输入的名称作为脚本名，不覆盖
    } else {
      // 用户输入的是目录路径，应该拼接文件名（使用用户输入的名称）
      const normalizedFolder = folderPath.endsWith('\\') || folderPath.endsWith('/') 
        ? folderPath.slice(0, -1) 
        : folderPath;
      fullPath = `${normalizedFolder}\\${fileName}`;
    }
  } else {
    // 相对路径
    const relativeFolder = folderPath ? folderPath.replace(/\\/g, '/') : '';
    const relativePath = relativeFolder ? `${relativeFolder}/${fileName}` : fileName;
    fullPath = path.join(SCRIPTS_DIR, relativePath);
  }
  
  try {
    const config = getConfig();
    const scriptId = Date.now().toString();
    
    config.scripts.push({
      id: scriptId,
      name: scriptName,
      type: 'script',
      path: fullPath,
      ext: finalExt,
      description: description || '',
      pythonEnv: (finalExt === 'py' && pythonEnv) ? pythonEnv : null,
      createdAt: new Date().toISOString()
    });
    
    saveConfig(config);
    
    res.json({ success: true, message: `已创建脚本: ${scriptName}`, path: fullPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/edit', (req, res) => {
  const { oldPath, newName, newFolderPath, newDescription, pythonEnv } = req.body;
  if (!oldPath) {
    return res.status(400).json({ error: '缺少原路径' });
  }
  
  try {
    const config = getConfig();
    const scriptIndex = config.scripts.findIndex(s => s.id === oldPath);
    
    if (scriptIndex === -1) {
      return res.status(404).json({ error: '脚本不存在' });
    }
    
    const script = config.scripts[scriptIndex];
    let oldExt = script.ext;
    let scriptName = newName ? newName.replace(/\.[^.]+$/, '') : script.name.replace(/\.[^.]+$/, '');
    let fileName = `${scriptName}.${oldExt}`;
    let newFullPath = script.path;
    
    if (newName || newFolderPath) {
      if (newFolderPath && (newFolderPath.startsWith('\\') || newFolderPath.match(/^[A-Za-z]:/))) {
          const extPattern = new RegExp(`\\.(${['ps1', 'py', 'js', 'bat', 'cmd', 'exe', 'sh', 'rb', 'php', 'pl', 'vbs', 'mjs', 'cjs'].join('|')})$`, 'i');
          if (extPattern.test(newFolderPath)) {
          // 用户输入的是完整文件路径
          newFullPath = newFolderPath;
          // 保留用户输入的脚本名
        } else {
          // 用户输入的是目录路径，应该拼接文件名（使用用户输入的名称）
          const normalizedFolder = newFolderPath.endsWith('\\') || newFolderPath.endsWith('/') 
            ? newFolderPath.slice(0, -1) 
            : newFolderPath;
          newFullPath = `${normalizedFolder}\\${fileName}`;
        }
      } else {
        const relativeFolder = newFolderPath ? newFolderPath.replace(/\\/g, '/') : '';
        const relativePath = relativeFolder ? `${relativeFolder}/${fileName}` : fileName;
        newFullPath = path.join(SCRIPTS_DIR, relativePath);
      }
      
      if (newFullPath !== script.path) {
        if (fs.existsSync(script.path)) {
          const newDir = path.dirname(newFullPath);
          if (!fs.existsSync(newDir)) {
            fs.mkdirSync(newDir, { recursive: true });
          }
          if (fs.existsSync(script.path)) {
            fs.renameSync(script.path, newFullPath);
          }
        }
      }
    }
    
    config.scripts[scriptIndex] = {
      ...script,
      name: scriptName,
      path: newFullPath,
      ext: oldExt,
      description: newDescription !== undefined ? newDescription : script.description,
      pythonEnv: (oldExt === 'py' && pythonEnv) ? pythonEnv : null
    };
    
    saveConfig(config);
    
    res.json({ success: true, message: '编辑成功', path: newFullPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function runScriptInternal(scriptId, pythonEnv) {
  const config = getConfig();
  const script = config.scripts.find(s => s.id === scriptId);
  if (!script) {
    console.error(`[CRON ERROR] 脚本不存在: ${scriptId}`);
    return;
  }
  
  const fullPath = script.path;
  const ext = script.ext;
  
  console.log(`[CRON DEBUG] 定时任务执行: ${script.name}`);
  console.log(`[CRON DEBUG] 脚本路径: ${fullPath}`);
  console.log(`[CRON DEBUG] 文件是否存在: ${fs.existsSync(fullPath)}`);
  
  if (ext === 'py' && !pythonEnv) {
    pythonEnv = script.pythonEnv || 'python';
  }
  
  let command, args;
  
  switch (ext) {
    case 'ps1':
      command = 'powershell';
      args = ['-ExecutionPolicy', 'Bypass', '-File', `"${fullPath}"`];
      break;
    case 'py':
      command = pythonEnv || 'python';
      args = ['-u', `"${fullPath}"`];
      break;
    case 'js':
      command = 'node';
      args = [`"${fullPath}"`];
      break;
    default:
      return;
  }
  
  console.log(`[CRON DEBUG] 执行命令: ${command} ${args.join(' ')}`);
  
  const processEnv = { 
    ...process.env, 
    PYTHONIOENCODING: 'utf-8', 
    PYTHONUTF8: '1',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    CPATH: 'utf-8',
    CMD_UTF8: '1'
  };
  
  // 设置工作目录为脚本所在目录，确保相对路径正确解析
  const scriptDir = path.dirname(fullPath);
  
  const child = spawn(command, args, { 
    env: processEnv,
    shell: true,
    cwd: scriptDir
  });
  
  // 添加到运行进程列表
  runningProcesses[scriptId] = {
    process: child,
    stdout: '',
    stderr: '',
    startTime: new Date().toISOString(),
    runId: Date.now().toString()
  };
  
  // 2秒后保存启动日志
  setTimeout(() => {
    const procInfo = runningProcesses[scriptId];
    if (!procInfo || logSaved) return;
    
    const stdout = procInfo.stdout || '';
    const stderr = procInfo.stderr || '';
    const output = (stdout + stderr).trim() || '脚本已启动，正在运行中...';
    
    const logs = getLogs();
    logs.push({
      scriptId: script.id,
      scriptName: script.name,
      timestamp: new Date().toISOString(),
      success: true,
      exitCode: null,
      output: output,
      triggeredBy: 'cron'
    });
    if (logs.length > 100) {
      logs.splice(0, logs.length - 100);
    }
    saveLogs(logs);
  }, 2000);
  
  child.stdout.on('data', (data) => {
    const output = data.toString();
    runningProcesses[scriptId].stdout += output;
    console.log(`[CRON STDOUT] ${output}`);
  });
  
  child.stderr.on('data', (data) => {
    const output = data.toString();
    runningProcesses[scriptId].stderr += output;
    console.log(`[CRON STDERR] ${output}`);
  });
  
  let logSaved = false;
  
  child.on('close', (code, signal) => {
    const procInfo = runningProcesses[scriptId];
    const exitCode = code !== null ? code : signal ? -1 : null;
    const stdout = procInfo ? procInfo.stdout || '' : '';
    const stderr = procInfo ? procInfo.stderr || '' : '';
    const output = (stdout + stderr).trim() || '无输出';
    
    // 保存执行日志
    const logs = getLogs();
    logs.push({
      scriptId: script.id,
      scriptName: script.name,
      timestamp: new Date().toISOString(),
      success: exitCode === 0,
      exitCode: exitCode,
      output: output,
      triggeredBy: 'cron'
    });
    if (logs.length > 100) {
      logs.splice(0, logs.length - 100);
    }
    saveLogs(logs);
    logSaved = true;
    
    // 从运行进程列表移除
    delete runningProcesses[scriptId];
    
    if (exitCode !== 0) {
      console.error(`[CRON ERROR] 执行失败，退出码: ${exitCode}`);
    } else {
      console.log(`[CRON DEBUG] 执行成功`);
    }
  });
  
  child.on('error', (err) => {
    console.error(`[CRON ERROR] 进程错误: ${err.message}`);
    delete runningProcesses[scriptId];
  });
}

app.post('/api/cron/create', (req, res) => {
  const { scriptId, scriptName, pythonEnv, type, interval, unit, time, weekday, day, expression } = req.body;
  
  if (!scriptId || !type) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  
  try {
    const cronConfig = getCronConfig();
    const taskId = Date.now().toString();
    
    let scheduleRule;
    
    switch (type) {
      case 'interval':
        const intervalMs = interval * (unit === 'seconds' ? 1000 : unit === 'minutes' ? 60000 : unit === 'hours' ? 3600000 : 86400000);
        cronJobs[taskId] = setInterval(() => {
          runScriptInternal(scriptId, pythonEnv);
        }, intervalMs);
        break;
      case 'daily':
        const [hours, minutes] = time.split(':').map(Number);
        scheduleRule = new schedule.RecurrenceRule();
        scheduleRule.hour = hours;
        scheduleRule.minute = minutes;
        cronJobs[taskId] = schedule.scheduleJob(taskId, scheduleRule, () => {
          runScriptInternal(scriptId, pythonEnv);
        });
        break;
      case 'weekly':
        const [wHours, wMinutes] = time.split(':').map(Number);
        scheduleRule = new schedule.RecurrenceRule();
        scheduleRule.dayOfWeek = weekday;
        scheduleRule.hour = wHours;
        scheduleRule.minute = wMinutes;
        cronJobs[taskId] = schedule.scheduleJob(taskId, scheduleRule, () => {
          runScriptInternal(scriptId, pythonEnv);
        });
        break;
      case 'monthly':
        const [mHours, mMinutes] = time.split(':').map(Number);
        scheduleRule = new schedule.RecurrenceRule();
        scheduleRule.date = day;
        scheduleRule.hour = mHours;
        scheduleRule.minute = mMinutes;
        cronJobs[taskId] = schedule.scheduleJob(taskId, scheduleRule, () => {
          runScriptInternal(scriptId, pythonEnv);
        });
        break;
      case 'cron':
        cronJobs[taskId] = schedule.scheduleJob(taskId, expression, () => {
          runScriptInternal(scriptId, pythonEnv);
        });
        break;
      default:
        return res.status(400).json({ error: '不支持的定时类型' });
    }
    
    cronConfig.tasks.push({
      id: taskId,
      scriptId,
      scriptName,
      pythonEnv,
      type,
      interval,
      unit,
      time,
      weekday,
      day,
      expression,
      createdAt: new Date().toISOString()
    });
    
    saveCronConfig(cronConfig);
    
    res.json({ success: true, message: `定时任务已创建: ${scriptName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 前端使用的定时任务创建路由
app.post('/api/cron/tasks', (req, res) => {
  const { scriptId, type, interval, expression, delay } = req.body;
  
  if (!scriptId || !type) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  
  try {
    const config = getConfig();
    const script = config.scripts.find(s => s.id === scriptId);
    
    if (!script) {
      return res.status(404).json({ error: '脚本不存在' });
    }
    
    const cronConfig = getCronConfig();
    const taskId = Date.now().toString();
    
    switch (type) {
      case 'interval':
        const intervalMs = interval * 60000; // 默认分钟
        cronJobs[taskId] = setInterval(() => {
          runScriptInternal(scriptId, script.pythonEnv);
        }, intervalMs);
        break;
      case 'cron':
        cronJobs[taskId] = schedule.scheduleJob(taskId, expression, () => {
          runScriptInternal(scriptId, script.pythonEnv);
        });
        break;
      case 'delay':
        const delayMs = delay * 60000; // 分钟转毫秒
        cronJobs[taskId] = setTimeout(() => {
          runScriptInternal(scriptId, script.pythonEnv);
          // 执行完成后自动删除任务
          const config = getCronConfig();
          const taskIndex = config.tasks.findIndex(t => t.id === taskId);
          if (taskIndex !== -1) {
            config.tasks.splice(taskIndex, 1);
            saveCronConfig(config);
          }
          delete cronJobs[taskId];
        }, delayMs);
        break;
      default:
        return res.status(400).json({ error: '不支持的定时类型' });
    }
    
    cronConfig.tasks.push({
      id: taskId,
      scriptId: script.id,
      scriptName: script.name,
      pythonEnv: script.pythonEnv,
      type,
      interval,
      expression,
      delay,
      enabled: true,
      createdAt: new Date().toISOString()
    });
    
    saveCronConfig(cronConfig);
    
    res.json({ success: true, message: `定时任务已创建: ${script.name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cron/tasks', (req, res) => {
  try {
    const cronConfig = getCronConfig();
    res.json(cronConfig.tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 前端使用的删除路由
app.delete('/api/cron/tasks/:id', (req, res) => {
  const taskId = req.params.id;
  
  try {
    if (cronJobs[taskId]) {
      if (typeof cronJobs[taskId].cancel === 'function') {
        cronJobs[taskId].cancel();
      } else if (typeof cronJobs[taskId] === 'number') {
        clearTimeout(cronJobs[taskId]);
      } else {
        clearInterval(cronJobs[taskId]);
      }
      delete cronJobs[taskId];
    }
    
    const cronConfig = getCronConfig();
    const taskIndex = cronConfig.tasks.findIndex(t => t.id === taskId);
    
    if (taskIndex !== -1) {
      const task = cronConfig.tasks[taskIndex];
      cronConfig.tasks.splice(taskIndex, 1);
      saveCronConfig(cronConfig);
      res.json({ success: true, message: `已删除定时任务: ${task.scriptName}` });
    } else {
      res.status(404).json({ error: '定时任务不存在' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 切换定时任务状态
app.post('/api/cron/tasks/:id/toggle', (req, res) => {
  const taskId = req.params.id;
  
  try {
    const cronConfig = getCronConfig();
    const task = cronConfig.tasks.find(t => t.id === taskId);
    
    if (!task) {
      return res.status(404).json({ error: '定时任务不存在' });
    }
    
    task.enabled = !task.enabled;
    saveCronConfig(cronConfig);
    
    if (task.enabled) {
      // 重新启动任务
      if (cronJobs[taskId]) {
        if (typeof cronJobs[taskId].cancel === 'function') {
          cronJobs[taskId].cancel();
        } else {
          clearInterval(cronJobs[taskId]);
        }
      }
      
      const config = getConfig();
      const script = config.scripts.find(s => s.id === task.scriptId);
      const pythonEnv = script ? script.pythonEnv : task.pythonEnv;
      
      if (task.type === 'interval') {
        const intervalMs = task.interval * 60000;
        cronJobs[taskId] = setInterval(() => {
          runScriptInternal(task.scriptId, pythonEnv);
        }, intervalMs);
      } else if (task.type === 'cron' && task.expression) {
        cronJobs[taskId] = schedule.scheduleJob(taskId, task.expression, () => {
          runScriptInternal(task.scriptId, pythonEnv);
        });
      } else if (task.type === 'delay' && task.delay) {
        const delayMs = task.delay * 60000;
        cronJobs[taskId] = setTimeout(() => {
          runScriptInternal(task.scriptId, pythonEnv);
          // 执行完成后自动删除任务
          const cfg = getCronConfig();
          const taskIndex = cfg.tasks.findIndex(t => t.id === taskId);
          if (taskIndex !== -1) {
            cfg.tasks.splice(taskIndex, 1);
            saveCronConfig(cfg);
          }
          delete cronJobs[taskId];
        }, delayMs);
      }
      
      res.json({ success: true, message: `已启用定时任务: ${task.scriptName}`, enabled: true });
    } else {
      // 停止任务
      if (cronJobs[taskId]) {
        if (typeof cronJobs[taskId].cancel === 'function') {
          cronJobs[taskId].cancel();
        } else {
          // setTimeout 返回的是 number
          clearTimeout(cronJobs[taskId]);
        }
        delete cronJobs[taskId];
      }
      res.json({ success: true, message: `已停止定时任务: ${task.scriptName}`, enabled: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cron/delete', (req, res) => {
  const { taskId } = req.body;
  
  if (!taskId) {
    return res.status(400).json({ error: '缺少任务ID' });
  }
  
  try {
    if (cronJobs[taskId]) {
      if (typeof cronJobs[taskId].cancel === 'function') {
        cronJobs[taskId].cancel();
      } else {
        clearInterval(cronJobs[taskId]);
      }
      delete cronJobs[taskId];
    }
    
    const cronConfig = getCronConfig();
    const taskIndex = cronConfig.tasks.findIndex(t => t.id === taskId);
    
    if (taskIndex !== -1) {
      const task = cronConfig.tasks[taskIndex];
      cronConfig.tasks.splice(taskIndex, 1);
      saveCronConfig(cronConfig);
      res.json({ success: true, message: `已删除定时任务: ${task.scriptName}` });
    } else {
      res.status(404).json({ error: '定时任务不存在' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function restoreCronTasks() {
  const cronConfig = getCronConfig();
  if (!cronConfig.tasks || cronConfig.tasks.length === 0) {
    console.log('[CRON] 无定时任务需要恢复');
    return;
  }
  
  console.log(`[CRON] 正在恢复 ${cronConfig.tasks.length} 个定时任务...`);
  
  cronConfig.tasks.forEach(task => {
    try {
      let scheduleRule;
      
      switch (task.type) {
        case 'interval':
          const intervalMs = task.interval * (task.unit === 'seconds' ? 1000 : task.unit === 'minutes' ? 60000 : task.unit === 'hours' ? 3600000 : 86400000);
          cronJobs[task.id] = setInterval(() => {
            runScriptInternal(task.scriptId, task.pythonEnv);
          }, intervalMs);
          break;
        case 'daily':
          const [dHours, dMinutes] = task.time.split(':').map(Number);
          scheduleRule = new schedule.RecurrenceRule();
          scheduleRule.hour = dHours;
          scheduleRule.minute = dMinutes;
          cronJobs[task.id] = schedule.scheduleJob(task.id, scheduleRule, () => {
            runScriptInternal(task.scriptId, task.pythonEnv);
          });
          break;
        case 'weekly':
          const [wHours, wMinutes] = task.time.split(':').map(Number);
          scheduleRule = new schedule.RecurrenceRule();
          scheduleRule.dayOfWeek = task.weekday;
          scheduleRule.hour = wHours;
          scheduleRule.minute = wMinutes;
          cronJobs[task.id] = schedule.scheduleJob(task.id, scheduleRule, () => {
            runScriptInternal(task.scriptId, task.pythonEnv);
          });
          break;
        case 'monthly':
          const [mHours, mMinutes] = task.time.split(':').map(Number);
          scheduleRule = new schedule.RecurrenceRule();
          scheduleRule.date = task.day;
          scheduleRule.hour = mHours;
          scheduleRule.minute = mMinutes;
          cronJobs[task.id] = schedule.scheduleJob(task.id, scheduleRule, () => {
            runScriptInternal(task.scriptId, task.pythonEnv);
          });
          break;
        case 'cron':
          cronJobs[task.id] = schedule.scheduleJob(task.id, task.expression, () => {
            runScriptInternal(task.scriptId, task.pythonEnv);
          });
          break;
      }
      
      console.log(`[CRON] 已恢复定时任务: ${task.scriptName}`);
    } catch (err) {
      console.error(`[CRON ERROR] 恢复定时任务失败: ${task.scriptName}, 错误: ${err.message}`);
    }
  });
}

app.post('/api/exit', (req, res) => {
  res.json({ success: true, message: '服务器正在关闭...' });
  
  // 关闭所有定时任务
  Object.keys(cronJobs).forEach(taskId => {
    try {
      cronJobs[taskId].cancel();
      console.log(`[EXIT] 已取消定时任务: ${taskId}`);
    } catch (err) {
      console.error(`[EXIT ERROR] 取消定时任务失败: ${taskId}`, err);
    }
  });
  
  // 终止所有运行中的进程（包括子进程）
  Object.keys(runningProcesses).forEach(scriptId => {
    try {
      const procInfo = runningProcesses[scriptId];
      const child = procInfo.process;
      
      if (child && child.pid) {
        // Windows 下使用 taskkill 强制终止进程树（包括所有子进程）
        if (process.platform === 'win32') {
          exec(`taskkill /pid ${child.pid} /T /F`, (err) => {
            if (err) {
              console.error(`[EXIT ERROR] taskkill 失败: ${err.message}`);
              // 尝试普通 kill
              child.kill('SIGKILL');
            } else {
              console.log(`[EXIT] 已终止进程树: ${scriptId} (PID: ${child.pid})`);
            }
          });
        } else {
          // Linux/Mac 使用 SIGKILL 强制终止
          child.kill('SIGKILL');
          console.log(`[EXIT] 已终止运行中的脚本: ${scriptId} (PID: ${child.pid})`);
        }
      }
    } catch (err) {
      console.error(`[EXIT ERROR] 终止脚本失败: ${scriptId}`, err);
    }
  });
  
  // 增加延迟时间，确保进程完全终止
  setTimeout(() => {
    process.exit(0);
  }, 2000);
});

function proxyRequest(req, res, targetHost, targetPort) {
  const options = {
    hostname: targetHost,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${targetHost}:${targetPort}`,
      connection: 'keep-alive'
    }
  };

  const protocol = targetPort === 443 ? https : http;
  
  const proxyReq = protocol.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['cross-origin-embedder-policy'];
    delete headers['cross-origin-opener-policy'];
    delete headers['cross-origin-resource-policy'];
    delete headers['x-frame-options'];
    delete headers['x-content-type-options'];
    
    // 处理下载响应头，确保浏览器能正确下载文件
    const contentType = headers['content-type'] || '';
    const urlPath = req.url.split('?')[0];
    const fileName = urlPath.substring(urlPath.lastIndexOf('/') + 1);
    const ext = fileName.split('.').pop().toLowerCase();
    
    // 判断是否为下载文件：基于扩展名或content-type
    const downloadExts = /\.(apk|exe|zip|rar|7z|tar|gz|iso|pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|bmp|svg|webp|mp4|avi|mkv|mov|mp3|wav|flac|htm|html|txt|csv|json|xml)$/i;
    const isDownloadByExt = downloadExts.test(req.url);
    const isBinaryContent = contentType.includes('application/octet-stream') || 
                            contentType.includes('image/') || 
                            contentType.includes('video/') || 
                            contentType.includes('audio/') ||
                            contentType.includes('application/pdf') ||
                            contentType.includes('application/zip');
    
    if (isDownloadByExt || isBinaryContent) {
      const decodedFileName = decodeURIComponent(fileName);
      
      // 设置正确的Content-Disposition头，强制浏览器下载而不是打开
      if (!headers['content-disposition']) {
        const encodedFileName = encodeURIComponent(decodedFileName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
        headers['content-disposition'] = `attachment; filename="${decodedFileName}"; filename*=UTF-8''${encodedFileName}`;
      } else if (headers['content-disposition'].includes('inline')) {
        // 如果原始头是inline，改为attachment强制下载
        headers['content-disposition'] = headers['content-disposition'].replace('inline', 'attachment');
      }
      
      // 确保Content-Type正确
      const mimeTypes = {
        'apk': 'application/vnd.android.package-archive',
        'exe': 'application/octet-stream',
        'zip': 'application/zip',
        'rar': 'application/vnd.rar',
        '7z': 'application/x-7z-compressed',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'bmp': 'image/bmp',
        'svg': 'image/svg+xml',
        'webp': 'image/webp',
        'mp4': 'video/mp4',
        'avi': 'video/x-msvideo',
        'mkv': 'video/x-matroska',
        'mov': 'video/quicktime',
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'flac': 'audio/flac',
        'htm': 'text/html',
        'html': 'text/html',
        'txt': 'text/plain',
        'csv': 'text/csv',
        'json': 'application/json',
        'xml': 'application/xml'
      };
      
      if (!contentType || contentType === 'application/octet-stream') {
        headers['content-type'] = mimeTypes[ext] || 'application/octet-stream';
      }
    }
    
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[PROXY ERROR] ${targetHost}:${targetPort} - ${err.message}`);
    res.status(503).json({ error: '目标服务不可用', details: err.message });
  });

  req.pipe(proxyReq);
}

app.all('/proxy/:port/*', (req, res) => {
  const targetPort = parseInt(req.params.port);
  const targetHost = 'localhost';
  
  if (isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
    return res.status(400).json({ error: '无效的端口号' });
  }

  req.url = decodeURIComponent('/' + req.params[0]);
  
  // 在转发前，先检查文件是否存在于工具自身的 static/uploads 目录
  // 如果存在，直接由工具返回文件，不再转发给目标服务
  const downloadMatch = req.url.match(/^\/download\/(.+)$/);
  if (downloadMatch) {
    const fileName = downloadMatch[1];
    const decodedFileName = decodeURIComponent(fileName);
    const filePath = path.join(BASE_DIR, 'static', 'uploads', decodedFileName);
    const resolvedFilePath = path.resolve(filePath);
    const uploadsDir = path.resolve(path.join(BASE_DIR, 'static', 'uploads'));
    
    // 安全检查：确保文件在 uploads 目录内
    if (resolvedFilePath.startsWith(uploadsDir) && fs.existsSync(resolvedFilePath)) {
      const ext = decodedFileName.split('.').pop().toLowerCase();
      
      // 设置正确的MIME类型和下载头
      const mimeTypes = {
        'apk': 'application/vnd.android.package-archive',
        'exe': 'application/octet-stream',
        'zip': 'application/zip',
        'rar': 'application/vnd.rar',
        '7z': 'application/x-7z-compressed',
        'tar': 'application/x-tar',
        'gz': 'application/gzip',
        'iso': 'application/iso9660',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'bmp': 'image/bmp',
        'svg': 'image/svg+xml',
        'webp': 'image/webp',
        'mp4': 'video/mp4',
        'avi': 'video/x-msvideo',
        'mkv': 'video/x-matroska',
        'mov': 'video/quicktime',
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'flac': 'audio/flac',
        'htm': 'text/html',
        'html': 'text/html',
        'txt': 'text/plain',
        'csv': 'text/csv',
        'json': 'application/json',
        'xml': 'application/xml'
      };
      
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const encodedFileName = encodeURIComponent(decodedFileName);
      
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${decodedFileName}"; filename*=UTF-8''${encodedFileName}`);
      res.setHeader('Content-Length', fs.statSync(resolvedFilePath).size);
      
      const fileStream = fs.createReadStream(resolvedFilePath);
      fileStream.pipe(res);
      return;
    }
  }
  
  // 文件不存在于工具目录，继续转发给目标服务
  proxyRequest(req, res, targetHost, targetPort);
});

app.all('/proxy/:port', (req, res) => {
  const targetPort = parseInt(req.params.port);
  const targetHost = 'localhost';
  
  if (isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
    return res.status(400).json({ error: '无效的端口号' });
  }

  req.url = '/';
  proxyRequest(req, res, targetHost, targetPort);
});

checkPortAvailable(PORT, (isInUse) => {
  if (isInUse) {
    const message = `端口 ${PORT} 已被占用，请关闭占用该端口的程序后重试。`;
    if (process.pkg) {
      exec(`msg * "${message}"`, () => {
        process.exit(1);
      });
    } else {
      console.error(message);
      process.exit(1);
    }
  } else {
    app.listen(PORT, () => {
      console.log(`服务器运行在 http://localhost:${PORT}`);
      console.log('按 Ctrl+C 停止服务器');
      if (process.pkg) {
        setTimeout(() => {
          openBrowser(`http://localhost:${PORT}`);
        }, 1000);
      }
      restoreCronTasks();
    });
  }
});
