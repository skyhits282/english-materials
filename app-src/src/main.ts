import { startRouter } from './router'
import { fetchContentBundle } from './content/loader'
import { seedContent } from './content/seed'
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
// 路由先行渲染，播种在后台完成；失败不阻塞做题以外页面
void fetchContentBundle()
  .then((bundle) => seedContent(bundle))
  .catch((err) => console.error('题库播种失败：', err))