const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(() => {
  // Run dependency installer script before opening the main window.
  async function runInstaller() {
    const installer = path.join(__dirname, '..', 'scripts', 'install_inference_dependencies.sh')
    if (!fs.existsSync(installer)) {
      console.log('Installer script not found, skipping.')
      return
    }

    if (process.platform === 'win32') {
      console.log('Installer script is a shell script; skipping on Windows.')
      return
    }

    return new Promise((resolve, reject) => {
      const child = spawn('bash', [installer], { cwd: path.join(__dirname, '..'), env: process.env })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d) => { console.log('[installer]', d.toString()) })
      child.stderr.on('data', (d) => { console.error('[installer]', d.toString()) })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error('Installer exited with code ' + code))
      })
      child.on('error', (err) => reject(err))
    })
  }

  (async () => {
    try {
      await runInstaller()
    } catch (err) {
      console.warn('Installer failed:', err)
      const res = await dialog.showMessageBox({
        type: 'warning',
        message: 'Dependency installer failed',
        detail: String(err),
        buttons: ['Continue', 'Quit'],
        defaultId: 0,
        cancelId: 1
      })
      if (res.response === 1) {
        app.quit()
        return
      }
    }

    createWindow()

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })()
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('select-files', async (event) => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'mp3'] }]
  })
  return res.canceled ? [] : res.filePaths
})

ipcMain.handle('run-files', async (event, files) => {
  const win = BrowserWindow.getFocusedWindow()
  const userData = app.getPath('userData')
  const runsDir = path.join(userData, 'runs')
  if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true })

  // Process files sequentially to keep UI simple
  for (const f of files) {
    const base = path.basename(f, path.extname(f))
    const outdir = path.join(runsDir, base + '_' + Date.now())
    fs.mkdirSync(outdir, { recursive: true })

    // Prefer explicit Python executable if provided, otherwise prefer project .venv, else system python3
    const repoRoot = path.join(__dirname, '..')
    const venvPython = path.join(repoRoot, '.venv', 'bin', 'python')
    const py = process.env.PYTHON_EXECUTABLE || (fs.existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3'))
    const script = path.join(__dirname, '..', 'scripts', 'ml_engine.py')
    const args = ['--input', f, '--output', outdir]

    const child = spawn(py, [script, ...args])

    let stderrBuf = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk
      // ml_engine prints PROGRESS: {json}
      const lines = chunk.split(/\r?\n/)
      for (const line of lines) {
        if (!line) continue
        if (line.startsWith('PROGRESS:')) {
          try {
            const payload = JSON.parse(line.replace('PROGRESS:', '').trim())
            win.webContents.send('progress', { file: f, outdir, payload })
          } catch (e) {
            // ignore malformed
          }
        } else {
          // Forward other stderr logs as log messages
          win.webContents.send('log', { file: f, line })
        }
      }
    })

    let stdoutBuf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => { stdoutBuf += c })

    await new Promise((resolve) => {
      child.on('close', (code) => {
        try {
          const result = JSON.parse(stdoutBuf)
          win.webContents.send('result', { file: f, outdir, result, code })
        } catch (e) {
          // include stderr for diagnostics when parse fails
          win.webContents.send('result', { file: f, outdir, result: { error: 'Failed to parse result', stderr: stderrBuf }, code })
        }
        resolve()
      })
    })
  }

  return { status: 'started' }
})
