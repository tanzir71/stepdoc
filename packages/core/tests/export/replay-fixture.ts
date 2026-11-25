import type { GuideInput, StepInput } from '@stepdoc/schema'

const steps: StepInput[] = []
function step(input: Omit<StepInput, 'id' | 'index'>) {
  steps.push({
    id: `fixture-${steps.length + 1}`,
    index: steps.length + 1,
    ...input,
  })
}
step({
  type: 'navigate',
  title: 'Open fixture',
  url: 'http://replay.test/start?token=discarded-query#discarded-fragment',
  expect: { urlMatches: '/start' },
})
step({ type: 'section', title: 'Exercise the exported actions' })
step({
  type: 'action',
  action: 'click',
  title: 'Prefer role over CSS',
  target: {
    role: 'button',
    name: 'Preferred',
    locators: [{ strategy: 'css', value: '#wrong', unique: true }],
  },
  expect: { text: { role: 'status', contains: 'Role worked' } },
})
step({
  type: 'action',
  action: 'click',
  title: 'Skip ambiguous role and use test ID',
  target: {
    role: 'button',
    name: 'Ambiguous',
    locators: [{ strategy: 'testId', value: 'correct' }],
  },
  expect: { text: { role: 'status', contains: 'Fallback worked' } },
})
step({
  type: 'action',
  action: 'click',
  title: 'Skip invalid selector and use CSS',
  target: {
    locators: [
      { strategy: 'css', value: ']' },
      { strategy: 'css', value: '#css' },
    ],
  },
  expect: { text: { role: 'status', contains: 'CSS worked' } },
})
step({
  type: 'action',
  action: 'dblclick',
  title: 'Double click',
  target: { role: 'button', name: 'Double' },
  expect: { text: { contains: 'Double worked' } },
})
step({
  type: 'action',
  action: 'hover',
  title: 'Hover',
  target: { role: 'button', name: 'Hover' },
  expect: { text: { contains: 'Hover worked' } },
})
step({
  type: 'action',
  action: 'check',
  title: 'Check',
  target: { role: 'checkbox', name: 'Accept' },
  expect: { text: { contains: 'Checked' } },
})
step({
  type: 'action',
  action: 'uncheck',
  title: 'Uncheck',
  target: { role: 'checkbox', name: 'Accept' },
  expect: { text: { contains: 'Unchecked' } },
})
step({
  type: 'action',
  action: 'fill',
  title: 'Fill from secret environment',
  target: { role: 'textbox', name: 'Contact' },
  value: { kind: 'secret', variable: 'contact' },
  expect: { text: { contains: 'Contact ready' } },
})
step({
  type: 'action',
  action: 'fill',
  title: 'Fill from variable environment',
  target: { locators: [{ strategy: 'label', value: 'Seats' }] },
  value: { kind: 'variable', variable: 'seats' },
  expect: { text: { contains: 'Seats ready' } },
})
step({
  type: 'action',
  action: 'select',
  title: 'Select label',
  target: { role: 'combobox', name: 'Plan' },
  value: { kind: 'literal', literal: 'Team' },
  expect: { text: { contains: 'Plan ready' } },
})
step({
  type: 'action',
  action: 'select',
  title: 'Select runtime label',
  target: { role: 'combobox', name: 'Plan' },
  value: { kind: 'variable', variable: 'plan' },
  expect: { text: { contains: 'Basic ready' } },
})
step({
  type: 'action',
  action: 'press',
  title: 'Press target key',
  target: { role: 'textbox', name: 'Contact' },
  key: 'Enter',
  expect: { text: { contains: 'Key worked' } },
})
step({
  type: 'action',
  action: 'press',
  title: 'Press global key',
  value: { kind: 'literal', literal: 'Escape' },
  expect: { text: { contains: 'Escape worked' } },
})
step({
  type: 'action',
  action: 'upload',
  title: 'Upload runtime file',
  target: { locators: [{ strategy: 'label', value: 'Attachment' }] },
  value: { kind: 'variable', variable: 'file' },
  expect: { text: { contains: 'File ready' } },
})
step({
  type: 'action',
  action: 'wait',
  title: 'Wait on target',
  target: { role: 'button', name: 'Preferred' },
})
step({
  type: 'action',
  action: 'wait',
  title: 'Wait on expectation',
  expect: {
    visible: { role: 'button', name: 'Preferred' },
    hidden: { role: 'dialog', name: 'Absent' },
  },
})
step({
  type: 'action',
  action: 'click',
  title: 'Nested frames and open shadow roots',
  target: {
    role: 'button',
    name: 'Inside',
    frame: ['#outer', '#inner'],
    shadowPath: ['outer-host', 'inner-host'],
  },
  expect: {
    visible: { role: 'heading', name: 'Shadow ready' },
    text: { role: 'heading', contains: 'Shadow ready' },
  },
})
step({
  type: 'navigate',
  title: 'Open done page',
  url: 'http://replay.test/done',
  expect: {
    urlMatches: '^http://replay\\.test/done$',
    visible: { role: 'heading', name: 'Completed' },
  },
})
step({
  type: 'assert',
  title: 'Check completion',
  expect: { text: { contains: 'Completed' }, hidden: { name: 'Unfinished' } },
})

export const replayGuide: GuideInput = {
  schema: 'stepdoc/guide@1',
  id: 'replay-fixture',
  title: 'Exported replay works',
  app: { name: 'Local fixture', origin: 'http://replay.test' },
  preconditions: ['Local fixture is available'],
  variables: [
    { name: 'contact', kind: 'secret' },
    { name: 'seats', kind: 'variable', type: 'number' },
    { name: 'plan', kind: 'variable' },
    { name: 'file', kind: 'variable' },
  ],
  steps,
  version: 1,
  createdAt: '2026-11-25T00:00:00Z',
  updatedAt: '2026-11-25T00:00:00Z',
}

export const pages: Record<string, string> = {
  '/': '<!doctype html><h1>Local fixture</h1>',
  '/start': `<!doctype html><title>Fixture</title><p role="status" id="status"></p>
<button onclick="statusText('Role worked')">Preferred</button><button id="wrong" onclick="statusText('Wrong target')">Wrong</button>
<button>Ambiguous</button><button data-testid="correct" onclick="statusText('Fallback worked')">Ambiguous</button>
<button id="css" onclick="statusText('CSS worked')">CSS</button><button ondblclick="statusText('Double worked')">Double</button><button onmouseenter="statusText('Hover worked')">Hover</button>
<label>Accept<input type="checkbox" onchange="statusText(this.checked?'Checked':'Unchecked')"></label>
<label>Contact<input oninput="if(this.value==='runtime-only-contact')statusText('Contact ready')" onkeydown="if(event.key==='Enter')statusText('Key worked')"></label>
<label>Seats<input oninput="if(this.value==='7')statusText('Seats ready')"></label>
<label>Plan<select onchange="statusText(this.value==='team'?'Plan ready':'Basic ready')"><option value="basic">Basic</option><option value="team">Team</option></select></label>
<label>Attachment<input type="file" onchange="if(this.files.length)statusText('File ready')"></label>
<iframe id="outer" src="/outer"></iframe>
<script>function statusText(text){document.querySelector('#status').textContent=text}document.addEventListener('keydown',e=>{if(e.key==='Escape')statusText('Escape worked')})</script>`,
  '/outer': '<!doctype html><iframe id="inner" src="/inner"></iframe>',
  '/inner': `<!doctype html><outer-host></outer-host><script>
const root=document.querySelector('outer-host').attachShadow({mode:'open'});root.innerHTML='<inner-host></inner-host>';
const inner=root.querySelector('inner-host').attachShadow({mode:'open'});inner.innerHTML='<button>Inside</button><h2 hidden>Shadow ready</h2>';
inner.querySelector('button').onclick=()=>inner.querySelector('h2').hidden=false;</script>`,
  '/done': '<!doctype html><h1>Completed</h1>',
}
