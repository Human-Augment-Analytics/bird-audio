const chooseBtn = document.getElementById('choose')
const startBtn = document.getElementById('start')
const filesList = document.getElementById('files')
const runsDiv = document.getElementById('runs')
const logEl = document.getElementById('log')

let selected = []

function renderFiles() {
  filesList.innerHTML = ''
  selected.forEach((f, i) => {
    const li = document.createElement('li')
    li.textContent = f
    filesList.appendChild(li)
  })
}

chooseBtn.addEventListener('click', async () => {
  const files = await window.api.selectFiles()
  if (files && files.length) {
    selected = files
    renderFiles()
  }
})

startBtn.addEventListener('click', async () => {
  if (!selected.length) return alert('No files selected')
  appendLog('Starting processing...')
  await window.api.runFiles(selected)
})

function appendLog(s) {
  logEl.textContent += s + '\n'
  logEl.scrollTop = logEl.scrollHeight
}

window.api.onProgress((d) => {
  appendLog(`PROGRESS ${d.file}: ${JSON.stringify(d.payload)}`)
  // show simple progress per run
  let card = document.getElementById('run-' + d.outdir)
  if (!card) {
    card = document.createElement('div')
    card.id = 'run-' + d.outdir
    card.className = 'run'
    card.innerHTML = `<h3>${d.file}</h3><div class="bar"><div class="fill" style="width:0%"></div></div><div class="eta"></div><pre class="result"></pre>`
    runsDiv.appendChild(card)
  }
  const fill = card.querySelector('.fill')
  const eta = card.querySelector('.eta')
  if (d.payload.total && d.payload.processed) {
    const pct = Math.round(100 * d.payload.processed / d.payload.total)
    fill.style.width = pct + '%'
    eta.textContent = `ETA: ${d.payload.eta_seconds}s (${d.payload.processed}/${d.payload.total})`
  }
})

window.api.onResult((d) => {
  appendLog(`RESULT ${d.file}: ${JSON.stringify(d.result)}`)
  let card = document.getElementById('run-' + d.outdir)
  if (!card) {
    card = document.createElement('div')
    card.id = 'run-' + d.outdir
    card.className = 'run'
    runsDiv.appendChild(card)
  }
  const resultEl = card.querySelector('.result') || document.createElement('pre')
  resultEl.className = 'result'
  resultEl.textContent = JSON.stringify(d.result, null, 2)
  card.appendChild(resultEl)
})

window.api.onLog((d) => {
  appendLog(`LOG ${d.file}: ${d.line}`)
})
