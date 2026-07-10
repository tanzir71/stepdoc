import { getGuide } from './db'
import { flattenImage } from './render'
import { getSupabase } from './supabase'
import { isTestStore, testGuides } from './test-store'

export async function renderGuideImages(id: string) {
  const guide = await getGuide(id)
  if (!guide) return null

  if (isTestStore()) {
    const stored = testGuides.get(id)!
    let count = 0
    for (const step of stored.steps) {
      if (!step.screenshot_path) continue
      step.rendered_path = `guides/${id}/${step.id}/rendered.webp`
      count += 1
    }
    return count
  }

  let count = 0
  for (const step of guide.steps) {
    if (!step.screenshot_path) continue
    const { data, error } = await getSupabase().storage.from('screenshots').download(step.screenshot_path)
    if (error) throw error
    const out = await flattenImage(Buffer.from(await data.arrayBuffer()), step.edits, step.click)
    const path = `guides/${id}/${step.id}/rendered.webp`
    const { error: uploadError } = await getSupabase().storage.from('screenshots').upload(path, out, {
      contentType: 'image/webp',
      upsert: true,
    })
    if (uploadError) throw uploadError
    const { error: updateError } = await getSupabase().from('steps').update({ rendered_path: path }).eq('id', step.id)
    if (updateError) throw updateError
    count += 1
  }
  return count
}
