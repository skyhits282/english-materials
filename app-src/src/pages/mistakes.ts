import type { PageRenderer } from '../router'

export const renderMistakes: PageRenderer = ({ container }) => {
  container.innerHTML = '<h1>错题本</h1><p class="muted">建设中</p>'
}