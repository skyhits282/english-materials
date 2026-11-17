import type { PageRenderer } from '../router'

export const renderExercise: PageRenderer = ({ container }) => {
  container.innerHTML = '<h1>学习练习</h1><p class="muted">建设中</p>'
}