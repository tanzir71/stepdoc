// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSelector, cssEscape } from '../src/selector'

describe('buildSelector', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  const select = (html:string, query:string) => { document.body.innerHTML=html; return buildSelector(document.querySelector(query)!) }
  it('prefers id',()=>expect(select('<button id="save">x</button>','button')).toBe('#save'))
  it('escapes id punctuation',()=>expect(select('<button id="save:now">x</button>','button')).toContain('save\\:now'))
  it('prefers data-testid after id',()=>expect(select('<button data-testid="save">x</button>','button')).toBe('[data-testid="save"]'))
  it('uses name',()=>expect(select('<form><input name="email"></form>','input')).toBe('body > form > input[name="email"]'))
  it('uses nth-of-type for same tags',()=>expect(select('<main><button>A</button><button>B</button></main>','button:nth-child(2)')).toBe('body > main > button:nth-of-type(2)'))
  it('does not number unique tag',()=>expect(select('<main><button>A</button><a>B</a></main>','button')).toBe('body > main > button'))
  it('distinguishes nested siblings',()=>expect(select('<main><section><span></span><span></span></section></main>','span:nth-child(2)')).toContain('span:nth-of-type(2)'))
  it('limits ancestry to five levels',()=>expect(select('<div><section><article><aside><p><span><button></button></span></p></aside></article></section></div>','button').split(' > ')).toHaveLength(5))
  it('omits html',()=>expect(select('<main><button/></main>','button')).not.toContain('html'))
  it('includes body',()=>expect(select('<main><button/></main>','button')).toMatch(/^body/))
  it.each(['button','a','input','select','textarea','img','div','span','label','article'] as const)('supports %s',tag=>expect(select(`<main><${tag}></${tag}></main>`,tag)).toContain(tag))
  it('escapes spaces',()=>expect(cssEscape('a b')).toContain('\\ '))
  it('escapes brackets',()=>expect(cssEscape('a[b]')).toContain('\\['))
  it('is stable',()=>{document.body.innerHTML='<main><button/><button/></main>';const el=document.querySelectorAll('button')[1]!;expect(buildSelector(el)).toBe(buildSelector(el))})
})
