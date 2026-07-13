/* global document, window, IntersectionObserver, setTimeout */
const reveals = document.querySelectorAll('.reveal')
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible')
      observer.unobserve(entry.target)
    }
  }), { threshold: .12 })
  reveals.forEach((node) => observer.observe(node))
} else reveals.forEach((node) => node.classList.add('visible'))

document.querySelectorAll('details').forEach((detail) => detail.addEventListener('toggle', () => {
  if (detail.open) document.querySelectorAll('details[open]').forEach((other) => {
    if (other !== detail) other.open = false
  })
}))

const stateLabel = document.querySelector('#capture-state')
const panelStatus = document.querySelector('#panel-status')
const steps = document.querySelector('#captured-steps')
const count = document.querySelector('#step-count')
const email = document.querySelector('#demo-email')
const save = document.querySelector('#fake-save')
const cursor = document.querySelector('#fake-cursor')
const start = document.querySelector('#start-capture')
let recording = false
let stepCount = 0

function addStep(text, note) {
  if (stepCount === 0) steps.innerHTML = ''
  stepCount += 1
  steps.insertAdjacentHTML('beforeend', `<div class="captured-step"><b>${String(stepCount).padStart(2, '0')}</b><span>${text}<small>${note}</small></span></div>`)
  count.textContent = `${stepCount} step${stepCount === 1 ? '' : 's'}`
  panelStatus.textContent = 'Recording invented actions'
}

start.addEventListener('click', () => {
  recording = !recording
  stateLabel.textContent = recording ? '● RECORDING' : 'CAPTURE COMPLETE'
  stateLabel.classList.toggle('recording', recording)
  start.textContent = recording ? 'Stop & build guide' : 'Start simulation'
  if (recording) {
    panelStatus.textContent = 'Click the highlighted fields'
    email.classList.add('highlight')
    cursor.style.transform = 'translate(70px, 125px)'
    setTimeout(() => {
      if (recording && stepCount === 0) {
        email.classList.add('redacted')
        addStep('Fill in the “Administrator email” field', 'Typed value omitted · region pixelated')
        email.classList.remove('highlight')
        save.classList.add('highlight')
        cursor.style.transform = 'translate(75px, 245px)'
      }
    }, 700)
  } else {
    save.classList.remove('highlight')
    panelStatus.textContent = `Guide ready · ${stepCount || 2} steps`
    if (stepCount < 2) addStep('Click “Save preferences”', 'Rules-based instruction · click marker added')
  }
})

save.addEventListener('click', () => {
  if (!recording) return
  if (stepCount < 1) {
    email.classList.add('redacted')
    addStep('Fill in the “Administrator email” field', 'Typed value omitted · region pixelated')
  }
  if (stepCount < 2) addStep('Click “Save preferences”', 'Rules-based instruction · click marker added')
  save.classList.remove('highlight')
  panelStatus.textContent = 'Two invented steps captured'
})

document.querySelector('#reset-capture').addEventListener('click', () => {
  recording = false
  stepCount = 0
  stateLabel.textContent = 'NOT RECORDING'
  stateLabel.classList.remove('recording')
  panelStatus.textContent = 'Ready to simulate'
  count.textContent = '0 steps'
  steps.innerHTML = '<p class="empty">Start the simulation, then click the highlighted fields.</p>'
  email.classList.remove('highlight', 'redacted')
  save.classList.remove('highlight')
  start.textContent = 'Start simulation'
  cursor.style.transform = 'none'
})
