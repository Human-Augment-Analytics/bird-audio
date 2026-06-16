const filesInput = document.getElementById('filesInput')
const startBtn = document.getElementById('start')
const filesList = document.getElementById('files')
const runsDiv = document.getElementById('runs')
const logEl = document.getElementById('log')

let selected = []

filesInput.addEventListener('change', (e) => {
  selected = Array.from(e.target.files).map(f => f.path)
  renderFiles()
})

function renderFiles() {
  filesList.innerHTML = ''
  selected.forEach((f) => {
    const li = document.createElement('li')
    li.textContent = f
    filesList.appendChild(li)
  })
}

startBtn.addEventListener('click', async () => {
  if (!selected.length) return alert('No files selected')
  appendLog('Starting processing...')
  try {
    await window.__TAURI__.invoke('run_files', { files: selected })
  } catch (e) { appendLog('Invoke error: ' + e) }
})

function appendLog(s) {
  logEl.textContent += s + '\n'
  logEl.scrollTop = logEl.scrollHeight
}

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
}
