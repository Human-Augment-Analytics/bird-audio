const filesInput = document.getElementById('filesInput')
const startBtn = document.getElementById('start')
const filesList = document.getElementById('files')
const runsDiv = document.getElementById('runs')
const logEl = document.getElementById('log')

let selected = []

function appendLog(s) {
  logEl.textContent += s + '\n'
  logEl.scrollTop = logEl.scrollHeight
  console.log(s)
}

function renderFiles() {
  filesList.innerHTML = ''
  selected.forEach((f) => {
    const li = document.createElement('li')
    li.textContent = f
    filesList.appendChild(li)
  })
}

filesInput.addEventListener('change', (e) => {
  // In Tauri, File objects include a `path` property. Fallback to name in browser.
  selected = Array.from(e.target.files).map(f => f.path || f.name || '')
  renderFiles()
})

startBtn.addEventListener('click', async () => {
  if (!selected.length) return alert('No files selected')
  appendLog('Starting processing...')

  if (window.__TAURI__ && window.__TAURI__.invoke) {
    try {
      await window.__TAURI__.invoke('run_files', { files: selected })
    } catch (e) { appendLog('Invoke error: ' + e) }
  } else {
    appendLog('Tauri API not available. Are you running inside the Tauri app?')
  }
})

// events from backend
if (window.__TAURI__ && window.__TAURI__.event) {
  window.__TAURI__.event.listen('progress', (e) => {
    const d = e.payload
    appendLog(`PROGRESS ${d.file}: ${JSON.stringify(d.payload)}`)
  })
  window.__TAURI__.event.listen('log', (e) => {
    const d = e.payload
    appendLog(`LOG ${d.file}: ${d.line}`)
  })
  window.__TAURI__.event.listen('result', (e) => {
    const d = e.payload
    appendLog(`RESULT ${d.file}: ${JSON.stringify(d.result)}`)
    // create details card (simplified)
    const card = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = d.file
    card.appendChild(summary)
    const pre = document.createElement('pre')
    pre.textContent = JSON.stringify(d.result, null, 2)
    card.appendChild(pre)
    runsDiv.appendChild(card)
  })
} else {
  // If Tauri API not available, show a prominent notice in the UI
  const note = document.createElement('div')
  note.style.padding = '8px'
  note.style.border = '1px solid #f00'
  note.style.background = '#fee'
  note.textContent = 'Warning: Tauri API not available in this context. The app must be run via the Tauri binary (npm run start). Open developer tools to inspect errors.'
  document.getElementById('app').insertBefore(note, document.getElementById('app').firstChild)
  appendLog('Tauri API not detected in renderer.')
}
