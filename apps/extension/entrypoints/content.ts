import { defineContentScript } from 'wxt/utils/define-content-script'
import { startContent } from '../src/content'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: true,
  main: startContent,
})
