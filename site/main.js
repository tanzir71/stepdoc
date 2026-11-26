const menu = document.getElementById('site-menu')
const openMenu = document.querySelector('[data-sd="landing-menu-open"]')
const closeMenu = document.querySelector('[data-sd="landing-menu-close"]')
const desktop = matchMedia('(min-width:768px)')
openMenu.hidden = false
function rememberMenu(open) {
  const url = new URL(location.href)
  if (open) url.searchParams.set('menu', 'open')
  else url.searchParams.delete('menu')
  history.replaceState(null, '', url)
  openMenu.setAttribute('aria-expanded', String(open))
}
openMenu.addEventListener('click', () => {
  menu.showModal()
  rememberMenu(true)
})
closeMenu.addEventListener('click', () => menu.close())
menu.addEventListener('close', () => {
  rememberMenu(false)
  if (!desktop.matches) openMenu.focus()
})
menu
  .querySelectorAll('a')
  .forEach((link) => link.addEventListener('click', () => menu.close()))
function layout() {
  if (desktop.matches && menu.open) menu.close()
  document.querySelectorAll('.faq details').forEach((detail) => {
    detail.open = desktop.matches
  })
}
desktop.addEventListener('change', layout)
layout()
if (
  !desktop.matches &&
  new URL(location.href).searchParams.get('menu') === 'open'
) {
  menu.showModal()
  rememberMenu(true)
}
