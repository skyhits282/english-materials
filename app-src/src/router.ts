export interface PageContext {
  container: HTMLElement
  params: URLSearchParams
}

export type PageRenderer = (ctx: PageContext) => void | Promise<void>

export interface RouteInfo {
  name: string
  params: URLSearchParams
}

export function parseHash(hash: string): RouteInfo {
  const raw = hash.replace(/^#\/?/, '')
  const [path, query = ''] = raw.split('?')
  return { name: path || 'today', params: new URLSearchParams(query) }
}

export function navigate(name: string, params: Record<string, string> = {}): void {
  const query = new URLSearchParams(params).toString()
  location.hash = `#/${name}${query ? '?' + query : ''}`
}

export function startRouter(pages: Record<string, PageRenderer>, container: HTMLElement): void {
  const tabbar = document.querySelectorAll<HTMLAnchorElement>('#tabbar a')
  const render = () => {
    const { name, params } = parseHash(location.hash)
    const page = pages[name] ?? pages['today']
    if (!page) throw new Error('缺少 today 页面')
    for (const a of tabbar) {
      const target = a.getAttribute('href')?.replace('#/', '') ?? ''
      if (target === name) a.setAttribute('aria-current', 'page')
      else a.removeAttribute('aria-current')
    }
    container.innerHTML = ''
    void page({ container, params })
  }
  addEventListener('hashchange', render)
  render()
}