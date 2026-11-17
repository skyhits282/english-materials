import type { PageRenderer } from '../router'

export const renderReport: PageRenderer = ({ container }) => {
  container.innerHTML = '<h1>学习报告</h1><p class="muted">建设中</p>'
}
