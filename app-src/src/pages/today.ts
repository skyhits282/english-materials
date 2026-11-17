import type { PageRenderer } from '../router'

export const renderToday: PageRenderer = ({ container }) => {
  container.innerHTML = '<h1>今日学习</h1><p class="muted">建设中</p>'
}
