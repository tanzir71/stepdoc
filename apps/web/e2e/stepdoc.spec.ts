import { expect, test, type APIRequestContext } from '@playwright/test'
import { onboardingSession } from './fixtures/session'

async function seed(request: APIRequestContext, count = 30) {
  const response = await request.post('/api/sessions', {
    data: onboardingSession(count),
  })
  expect(response.status()).toBe(201)
  return (await response.json()).id as string
}

test('session API, list, search and 30-step viewer', async ({ page, request }) => {
  const id = await seed(request)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Browser onboarding' })).toBeVisible()
  await expect(page.getByText('30 steps')).toBeVisible()
  await page.getByLabel('Search guides').fill('Browser')
  await page.getByLabel('Search guides').press('Enter')
  await expect(page.getByRole('heading', { name: 'Browser onboarding' })).toBeVisible()
  await page.goto(`/guides/${id}`)
  await expect(page.locator('.step')).toHaveCount(30)
  await expect(page.getByText('Complete action 30')).toBeVisible()
})

test('editor autosaves text, adds sections, keyboard navigation and persists', async ({ page, request }) => {
  const id = await seed(request, 3)
  await page.goto(`/guides/${id}/edit`)
  // Wait for the actual persisted autosave before reloading.
  const autosaved = page.waitForResponse(
    (response) => response.url().endsWith(`/api/guides/${id}`) && response.request().method() === 'PATCH' && response.ok(),
  )
  await page.getByLabel('Guide title').fill('Edited onboarding')
  await page.getByRole('button', { name: '+ Section header' }).click()
  await autosaved
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })
  await page.reload()
  await expect(page.getByLabel('Guide title')).toHaveValue('Edited onboarding')
  await expect(page.locator('.stepedit')).toHaveCount(4)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('e')
  await expect(page.locator('[data-step-index="1"] textarea')).toBeFocused()
})

test('share can be enabled and revoked immediately', async ({ page, request }) => {
  const id = await seed(request, 2)
  await page.goto(`/guides/${id}/edit`)
  await page.getByRole('button', { name: 'Enable public link' }).click()
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })
  const link = await page.getByLabel('Public link').inputValue()
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Browser onboarding' })).toBeVisible()
  await page.goto(`/guides/${id}/edit`)
  // Hold revocation at the transport boundary. Saved must never describe the
  // optimistic toggle while its debounced write is still pending.
  let releaseRevoke!: () => void
  const held = new Promise<void>((resolve) => { releaseRevoke = resolve })
  await page.route(`**/api/guides/${id}`, async (route) => {
    if (route.request().method() === 'PATCH') await held
    await route.continue()
  })
  const revoking = page.waitForRequest((request) =>
    request.url().endsWith(`/api/guides/${id}`) && request.method() === 'PATCH' && request.postDataJSON().isPublic === false,
  )
  const revoked = page.waitForResponse((response) =>
    response.url().endsWith(`/api/guides/${id}`) && response.request().method() === 'PATCH' && response.ok(),
  )
  try {
    await page.getByRole('button', { name: 'Revoke public link' }).click()
    await expect(page.getByText('Saving...', { exact: true })).toBeVisible()
    await revoking
    await expect(page.getByText('Saved', { exact: true })).not.toBeVisible()
  } finally { releaseRevoke() }
  await revoked
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Guide not found' })).toBeVisible()
})

test('HTML, Markdown ZIP and PDF exports have typed downloadable bodies', async ({ request }) => {
  const id = await seed(request, 2)
  const html = await request.get(`/api/guides/${id}/export/html`)
  expect(html.headers()['content-type']).toContain('text/html')
  expect(await html.text()).toContain('Complete action 1')
  const md = await request.get(`/api/guides/${id}/export/md`)
  expect(md.headers()['content-type']).toContain('application/zip')
  expect((await md.body()).length).toBeGreaterThan(100)
  const pdf = await request.get(`/api/guides/${id}/export/pdf`)
  expect(pdf.headers()['content-type']).toContain('application/pdf')
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF')
})

test('ten reorder mutations persist exact contiguous positions', async ({ request }) => {
  const id = await seed(request, 10)
  for (let n = 0; n < 10; n++) {
    const guide = await (await request.get(`/api/guides/${id}`)).json()
    guide.steps.unshift(guide.steps.pop())
    const response = await request.patch(`/api/guides/${id}`, {
      data: {
        steps: guide.steps.map((step: { id: string; type: string; text: string }, i: number) => ({
          id: step.id,
          position: i,
          type: step.type,
          text: step.text,
        })),
      },
    })
    expect(response.ok()).toBeTruthy()
  }
  const final = await (await request.get(`/api/guides/${id}`)).json()
  expect(final.steps.map((step: { position: number }) => step.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(final.steps.map((step: { text: string }) => step.text)).toEqual(
    Array.from({ length: 10 }, (_, i) => `Complete action ${i + 1}`),
  )
})

test('manual image upload opens canvas tools and edits survive autosave', async ({ page, request }) => {
  const id = await seed(request, 1)
  await page.goto(`/guides/${id}/edit`)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Upload image' }).click()
  const file = await chooser
  // Check the completed upload before expecting its editor UI.
  const uploaded = page.waitForResponse(response => response.url().includes(`/api/guides/${id}/steps/`) && response.url().endsWith('/image') && response.request().method() === 'POST')
  await file.setFiles({
    name: 'shot.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  })
  expect((await uploaded).status()).toBe(200)
  await expect(page.getByRole('img', { name: 'Screenshot image editor' })).toBeVisible()
  await page.getByLabel('Image tool').selectOption('blur')
  const canvas = page.getByRole('img', { name: 'Screenshot image editor' })
  const box = await canvas.boundingBox()
  expect(box).toBeTruthy()
  await page.mouse.move(box!.x + 50, box!.y + 50)
  await page.mouse.down()
  await page.mouse.move(box!.x + 150, box!.y + 110)
  await page.mouse.up()
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })
  const guide = await (await request.get(`/api/guides/${id}`)).json()
  expect(guide.steps[0].edits.blur).toHaveLength(1)
  expect(guide.steps[0].rendered_path).toContain('/rendered.webp')
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByRole('button', { name: 'Redo' }).click()
})

test('viewer opens a 50-step guide quickly on localhost', async ({ page, request }) => {
  const id = await seed(request, 50)
  await page.goto(`/guides/${id}`)
  await expect(page.locator('.step')).toHaveCount(50)
  const started = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('.step')).toHaveCount(50)
  expect(Date.now() - started).toBeLessThan(1500)
})

test('copy Markdown writes clipboard content', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const id = await seed(request, 2)
  await page.goto(`/guides/${id}`)
  await page.getByRole('button', { name: 'Copy Markdown' }).click()
  await expect(page.getByRole('status')).toContainText('Markdown copied')
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain('# Browser onboarding')
  expect(copied).toContain('Complete action 2')
})
