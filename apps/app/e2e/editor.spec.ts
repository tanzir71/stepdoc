import { test, expect, type Page } from '@playwright/test'
import { hook } from './helpers'
import { prepareEditor, storedGuide } from './editor-helpers'

const saved = (page: Page) =>
  expect(hook(page, 'editor-save-status')).toContainText('Saved ·')
test('edits text, targets and privacy-safe runtime inputs, then reloads durable versions', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepareEditor(page)
  await hook(page, 'step-title').fill('Open the plan picker')
  await hook(page, 'step-description').fill('Choose a workspace plan.')
  await page.keyboard.press('Control+s')
  await saved(page)
  await expect
    .poll(async () => (await storedGuide(page)).steps[2]!.title)
    .toBe('Open the plan picker')
  await hook(page, 'target-action').selectOption('fill')
  await expect(hook(page, 'target-variable')).toBeVisible()
  await expect
    .poll(async () => (await storedGuide(page)).steps[2]!.value?.kind)
    .toBe('secret')
  await hook(page, 'target-url').fill(
    'https://owner:synthetic@example.com/settings?token=synthetic#private',
  )
  await hook(page, 'target-url').press('Enter')
  await page.keyboard.press('Control+s')
  await saved(page)
  const stored = await storedGuide(page)
  expect(stored.steps[2]!.url).toBe('https://example.com/settings')
  expect(stored.steps[2]!.value).toMatchObject({ kind: 'secret' })
  expect(stored.verification?.status).toBe('never-run')
  expect(JSON.stringify(stored)).not.toContain('synthetic')
  await page.reload()
  await expect(hook(page, 'step-title')).toHaveValue('Open the plan picker')
  await hook(page, 'target-action').selectOption('click')
  await hook(page, 'target-locator-edit').first().click()
  await hook(page, 'locator-name').fill('Choose plan')
  await hook(page, 'locator-save').click()
  await expect(hook(page, 'target-locator-edit').first()).toContainText(
    'Choose plan',
  )
  await expect(page.locator('.generated-replay')).toContainText('Choose plan')
  await hook(page, 'target-expect-open').click()
  await hook(page, 'target-expect-kind').selectOption('url')
  await hook(page, 'target-expect-url').fill(
    'https://owner:synthetic@example.com/done?token=synthetic#private',
  )
  await hook(page, 'target-expect-url').press('Enter')
  await page.keyboard.press('Control+s')
  await saved(page)
  expect((await storedGuide(page)).steps[2]!.expect?.urlMatches).toBe(
    'https://example.com/done',
  )
  expect(JSON.stringify(await storedGuide(page))).not.toContain('synthetic')
  await hook(page, 'target-expect-url').fill('/done?token=synthetic#private')
  await hook(page, 'target-expect-url').press('Enter')
  await page.keyboard.press('Control+s')
  await saved(page)
  expect((await storedGuide(page)).steps[2]!.expect?.urlMatches).toBe('/done')
  await hook(page, 'inspector-history').click()
  await expect(
    page.getByRole('list', { name: 'Saved versions' }),
  ).toContainText('Version 12')
  expect((await storedGuide(page)).version).toBeGreaterThan(12)
  expect(errors).toEqual([])
})
test('adds sections/manual steps, reorders with Alt arrows and persists undo/redo/delete', async ({
  page,
}) => {
  await prepareEditor(page)
  await hook(page, 'editor-add-step').click()
  await hook(page, 'step-add-type').selectOption('section')
  await hook(page, 'step-add-title').fill('Confirm the plan')
  await hook(page, 'step-add-save').click()
  await expect(hook(page, 'step-title')).toHaveValue('Confirm the plan')
  await expect(page).toHaveURL(/step=4/)
  await page.getByRole('option').filter({ hasText: 'Confirm the plan' }).focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(page).toHaveURL(/step=3/)
  await hook(page, 'editor-undo').click()
  await page.keyboard.press('Control+s')
  await saved(page)
  expect((await storedGuide(page)).steps[3]!.title).toBe('Confirm the plan')
  await hook(page, 'editor-redo').click()
  await page.keyboard.press('Control+s')
  await saved(page)
  expect((await storedGuide(page)).steps[2]!.title).toBe('Confirm the plan')
  await hook(page, 'inspector-step').click()
  await hook(page, 'step-delete').click()
  await hook(page, 'step-delete-confirm').click()
  await page.keyboard.press('Control+s')
  await saved(page)
  expect((await storedGuide(page)).steps).toHaveLength(9)
  await page.locator('#step-3').dragTo(page.locator('#step-2'))
  await page.keyboard.press('Control+s')
  await saved(page)
  expect((await storedGuide(page)).steps[1]!.title).toBe('Click "Change plan"')
  await hook(page, 'editor-undo').click()
  await page.keyboard.press('Control+s')
  await saved(page)
  await hook(page, 'editor-mode-agent').click()
  await expect(
    page.getByRole('heading', { name: 'Agent text view' }),
  ).toBeVisible()
  await expect(page.locator('.editor-agent-view pre')).toContainText(
    'STEPDOC_INVOICE_EMAIL',
  )
  await hook(page, 'editor-mode-preview').click()
  await expect(page.locator('#step-3[data-sd-step="3"] h2')).toHaveText(
    'Click "Change plan"',
  )
  await page.reload()
  await expect(
    page.getByRole('tabpanel', { name: 'Preview', exact: true }),
  ).toBeVisible()
})
test('edits layers by numbers and persists client-redacted source/render pixels and crop dimensions', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await prepareEditor(page)
  await hook(page, 'canvas-tool-blur').click()
  await hook(page, 'canvas-add-selected-tool').click()
  await hook(page, 'canvas-layer-x').fill('0')
  await hook(page, 'canvas-layer-y').fill('0')
  await hook(page, 'canvas-layer-width').fill('200')
  await hook(page, 'canvas-layer-height').fill('120')
  await page.keyboard.press('Control+s')
  await saved(page)
  const masked = await storedGuide(page),
    mask = masked.steps[2]!.redactions.at(-1)!
  expect(mask.rect).toEqual({ x: 0, y: 0, width: 200, height: 120 })
  const changed = await page.evaluate(async () => {
    const path = '/src/repository.ts'
    const repo: typeof import('../src/repository') = await import(
      /* @vite-ignore */ path
    )
    const adapter = await repo.getStorage()
    const guide = await adapter.getGuide('editor-guide')
    const step = guide.steps[2]!
    const raw = await (await fetch('/e2e/fixtures/editor-original.png')).blob()
    const safe = await adapter.getBlob(step.screenshot!.original!)
    const pixels = async (file: Blob) => {
      const image = await createImageBitmap(file)
      const canvas = new OffscreenCanvas(image.width, image.height)
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      image.close()
      return context.getImageData(0, 0, 200, 120).data
    }
    const a = await pixels(raw),
      b = await pixels(safe)
    let changes = 0
    for (let i = 0; i < a.length; i += 4)
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2])
        changes++
    return changes
  })
  expect(changed).toBeGreaterThan(50)
  await hook(page, 'canvas-tool-crop').click()
  await expect(hook(page, 'canvas-image')).toHaveAttribute('aria-busy', 'false')
  await hook(page, 'canvas-add-selected-tool').click()
  await hook(page, 'canvas-layer-x').fill('10')
  await hook(page, 'canvas-layer-y').fill('20')
  await hook(page, 'canvas-layer-width').fill('400')
  await hook(page, 'canvas-layer-height').fill('300')
  await page.keyboard.press('Control+s')
  await saved(page)
  expect((await storedGuide(page)).steps[2]!.screenshot).toMatchObject({
    width: 400,
    height: 300,
  })
  await page.reload()
  await expect(hook(page, 'canvas-image')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.editor-image img')).toHaveJSProperty(
    'naturalWidth',
    400,
  )
})
test('native concurrent tabs merge independent edits and keep same-field conflicts as a separate guide', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000)
  await prepareEditor(page)
  const other = await context.newPage()
  await other.goto('/g/editor-guide/edit?step=3')
  await expect(hook(other, 'step-title')).toHaveValue('Click "Change plan"')
  await hook(page, 'step-title').fill('Remote title')
  await page.keyboard.press('Control+s')
  await saved(page)
  await hook(other, 'step-description').fill('Local description')
  await other.keyboard.press('Control+s')
  await expect(
    other.getByRole('dialog', { name: 'Another tab saved a newer version' }),
  ).toBeVisible()
  await hook(other, 'editor-conflict-merge').click()
  await saved(other)
  expect((await storedGuide(page)).steps[2]).toMatchObject({
    title: 'Remote title',
    description: 'Local description',
  })
  await page.reload()
  await expect(hook(page, 'step-title')).toHaveValue('Remote title')
  await hook(page, 'step-title').fill('Next remote title')
  await page.keyboard.press('Control+s')
  await saved(page)
  await hook(other, 'step-title').fill('Conflicting local title')
  await other.keyboard.press('Control+s')
  await expect(
    other.getByRole('dialog', { name: 'Another tab saved a newer version' }),
  ).toBeVisible()
  await hook(other, 'editor-conflict-merge').click()
  await expect(
    other
      .getByRole('alert')
      .filter({ hasText: 'fields changed in both copies' }),
  ).toBeVisible()
  await hook(other, 'editor-conflict-copy').click()
  await expect(other).not.toHaveURL(/\/g\/editor-guide\/edit/)
  await expect(hook(other, 'step-title')).toHaveValue('Conflicting local title')
  await saved(other)
  expect((await storedGuide(page)).steps[2]!.title).toBe('Next remote title')
  await other.close()
})
test('guards link and browser-back navigation until edits are saved or explicitly discarded', async ({
  page,
}) => {
  await prepareEditor(page)
  await page.goto('/g/editor-guide')
  await hook(page, 'guide-edit').click()
  await expect(hook(page, 'step-title')).toBeVisible()
  await page.clock.install({ time: new Date('2026-11-25T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-25T12:00:01Z'))
  await hook(page, 'step-title').fill('Save before back')
  await page.goBack()
  await expect(
    page.getByRole('dialog', { name: 'Save before leaving?' }),
  ).toBeVisible()
  await hook(page, 'editor-leave-stay').click()
  await expect(hook(page, 'step-title')).toHaveValue('Save before back')
  await hook(page, 'editor-library').click()
  await hook(page, 'editor-leave-save').click()
  await expect(page).toHaveURL('/')
  expect((await storedGuide(page)).steps[0]!.title).toBe('Save before back')
  // A full reload must let React's lazy-route scheduler finish before freezing
  // autosave for the next unsaved-navigation assertion.
  await page.clock.resume()
  await page.goto('/g/editor-guide/edit?step=1')
  await expect(hook(page, 'step-title')).toHaveValue('Save before back')
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  await hook(page, 'step-title').fill('Discard this edit')
  await hook(page, 'editor-library').click()
  await hook(page, 'editor-leave-discard').click()
  await expect(page).toHaveURL('/')
  expect((await storedGuide(page)).steps[0]!.title).toBe('Save before back')
})
test('edits rectangle captions by numbers, nudges the whole layer and clears only the caption pixels', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await prepareEditor(page)
  await hook(page, 'canvas-layer-select').nth(1).click()
  await expect(hook(page, 'canvas-layer-text')).toHaveValue('Owners only')
  await page
    .getByRole('spinbutton', { name: 'Label x', exact: true })
    .fill('880')
  await page
    .getByRole('spinbutton', { name: 'Label y', exact: true })
    .fill('270')
  await hook(page, 'canvas-layer-text').fill('Workspace owner')
  await page.keyboard.press('Control+s')
  await saved(page)
  expect(
    (await storedGuide(page)).steps[2]!.edits!.annotations![0],
  ).toMatchObject({ text: 'Workspace owner', toX: 880, toY: 270 })
  const pixelPair = () =>
    page.evaluate(async () => {
      const path = '/src/repository.ts'
      const repo: typeof import('../src/repository') = await import(
        /* @vite-ignore */ path
      )
      const adapter = await repo.getStorage(),
        guide = await adapter.getGuide('editor-guide')
      const image = guide.steps[2]!.screenshot!
      return Promise.all(
        [image.original!, image.rendered].map(async (key) => {
          const bitmap = await createImageBitmap(await adapter.getBlob(key))
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
            ctx = canvas.getContext('2d')!
          ctx.drawImage(bitmap, 0, 0)
          bitmap.close()
          const pixel = Array.from(ctx.getImageData(882, 292, 1, 1).data)
          canvas.width = canvas.height = 1
          return pixel
        }),
      )
    })
  const painted = await pixelPair()
  expect(painted[1]).toEqual([242, 85, 31, 255])
  expect(painted[0]).not.toEqual(painted[1])
  await page.reload()
  await expect(hook(page, 'canvas-layer-text')).toHaveValue('Workspace owner')
  await hook(page, 'canvas-layer-select').nth(1).focus()
  await page.keyboard.press('Alt+ArrowRight')
  await page.keyboard.press('Control+s')
  await saved(page)
  expect(
    (await storedGuide(page)).steps[2]!.edits!.annotations![0],
  ).toMatchObject({ x: 1081, y: 188, toX: 881, toY: 270 })
  await hook(page, 'canvas-image').scrollIntoViewIfNeeded()
  await hook(page, 'canvas-layer-select').first().click()
  const box = await hook(page, 'canvas-image').boundingBox()
  await page.mouse.click(
    box!.x + (890 / 1280) * box!.width,
    box!.y + (290 / 800) * box!.height,
  )
  await expect(hook(page, 'canvas-layer-select').nth(1)).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await hook(page, 'canvas-layer-text').fill('')
  await page.keyboard.press('Control+s')
  await saved(page)
  const cleared = await pixelPair()
  expect(cleared[1]).toEqual(cleared[0])
  await page.reload()
  await expect(hook(page, 'canvas-layer-text')).toHaveValue('')
})

test('uploads/annotates an image in the client and continues saving offline', async ({
  page,
  context,
}) => {
  await prepareEditor(page)
  await hook(page, 'inspector-step').click()
  await hook(page, 'editor-image-file').setInputFiles(
    'e2e/fixtures/editor-original.png',
  )
  await expect(hook(page, 'activity-live')).toContainText(
    'Image processed in this browser and saved.',
  )
  await expect(hook(page, 'canvas-image')).toHaveAttribute('aria-busy', 'false')
  await hook(page, 'canvas-tool-rectangle').click()
  const box = await hook(page, 'canvas-image').boundingBox()
  expect(box).toBeTruthy()
  await page.mouse.move(box!.x + 80, box!.y + 60)
  await page.mouse.down()
  await page.mouse.move(box!.x + 180, box!.y + 120)
  await page.mouse.up()
  await page.keyboard.press('Control+s')
  await saved(page)
  expect((await storedGuide(page)).steps[2]!.edits?.annotations).toHaveLength(1)
  const before = (await storedGuide(page)).steps[2]!.edits!.annotations![0]!
  await hook(page, 'canvas-tool-select').click()
  await expect(hook(page, 'canvas-image')).toHaveAttribute('aria-busy', 'false')
  await page.mouse.move(box!.x + 100, box!.y + 80)
  await page.mouse.down()
  await page.mouse.move(box!.x + 125, box!.y + 90)
  await page.mouse.up()
  await page.keyboard.press('Control+s')
  await saved(page)
  const moved = (await storedGuide(page)).steps[2]!.edits!.annotations![0]!
  expect(moved.x).toBeGreaterThan(before.x)
  expect(moved.y).toBeGreaterThan(before.y)
  await hook(page, 'canvas-tool-arrow').click()
  await expect(hook(page, 'canvas-image')).toHaveAttribute('aria-busy', 'false')
  await page.mouse.move(box!.x + 280, box!.y + 220)
  await page.mouse.down()
  await page.mouse.move(box!.x + 220, box!.y + 180)
  await page.mouse.up()
  await page.keyboard.press('Control+s')
  await saved(page)
  const arrow = (await storedGuide(page)).steps[2]!.edits!.annotations![1]!
  expect(arrow.type).toBe('arrow')
  expect(arrow.toX).toBeLessThan(arrow.x)
  expect(arrow.toY).toBeLessThan(arrow.y)
  await context.setOffline(true)
  await hook(page, 'step-title').fill('Edited offline')
  await page.keyboard.press('Control+s')
  await saved(page)
  expect((await storedGuide(page)).steps[2]!.title).toBe('Edited offline')
  await context.setOffline(false)
})
