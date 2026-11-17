import type { PageRenderer } from '../router'

export const renderSettings: PageRenderer = ({ container }) => {
  container.innerHTML = '<h1>家长设置</h1><p class="muted">建设中</p>'
}
