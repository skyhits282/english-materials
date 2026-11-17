import { startRouter } from './router'
import { fetchContentBundle } from './content/loader'
import { seedContent } from './content/seed'
import { renderToday } from './pages/today'
import { renderExercise } from './pages/exercise'
import { renderMistakes } from './pages/mistakes'
import { renderReport } from './pages/report'
import { renderSettings } from './pages/settings'
import { isStorageAvailable } from './db/availability'

const container = document.querySelector<HTMLElement>('#app')
if (!container) throw new Error('缺少 #app 容器')
void isStorageAvailable().then((ok) => {
  if (!ok) {
    const banner = document.createElement('div')
    banner.className = 'error-panel'
    banner.setAttribute('role', 'alert')
    banner.textContent = '无法保存学习记录（浏览器存储不可用）。可以继续练习，但刷新后记录不会保留。'
    container.prepend(banner)
    // 页面渲染会整体替换 container.innerHTML，横幅需在每次渲染后重新置顶
    const observer = new MutationObserver(() => {
      if (!banner.isConnected) container.prepend(banner)
    })
    observer.observe(container, { childList: true })
  }
})
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
