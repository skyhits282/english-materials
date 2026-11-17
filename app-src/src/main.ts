import { startRouter } from './router'
import { renderToday } from './pages/today'
import { renderExercise } from './pages/exercise'
import { renderMistakes } from './pages/mistakes'
import { renderReport } from './pages/report'
import { renderSettings } from './pages/settings'

const container = document.querySelector<HTMLElement>('#app')
if (!container) throw new Error('缺少 #app 容器')
startRouter(
  {
    today: renderToday,
    exercise: renderExercise,
    mistakes: renderMistakes,
    report: renderReport,
    settings: renderSettings,
  },
  container,
)
