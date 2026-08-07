/**
 * 复习排程（SM-2 简化版，和 Anki 同源）。
 *
 * 纯函数，没有存储依赖：service worker 用它算下一次到期时间，
 * 生词本页面用同一份逻辑在按钮上预告"点这个下次什么时候再问"，两边不会算出不同结果。
 *
 * ES module，service worker 与扩展页面都直接 import；内容脚本用不到，不进 shared.js。
 */

export const DAY = 24 * 3600 * 1000;
export const GRADES = ['again', 'hard', 'good', 'easy'];

const MIN_EASE = 1.3;
const MAX_EASE = 3.0;
/** 答"忘记"的词 10 分钟后再出现，当天就能补一遍，不用等到明天 */
export const AGAIN_DELAY = 10 * 60 * 1000;
/** 间隔到 21 天以上算掌握，和 Anki 的成熟卡口径一致 */
export const MASTERED_INTERVAL = 21;

/**
 * 算下一次排程，不改入参。now 由调用方传，便于测试固定时间。
 * 返回 { ease, interval, due, reps, lapses, lastGrade, lastReviewedAt }
 */
export function schedule(entry, grade, now) {
  const prevInterval = Number(entry?.interval) || 0;
  let ease = Number(entry?.ease) || 2.5;
  let interval;
  let due;

  switch (grade) {
    case 'again':
      ease -= 0.2;
      interval = 0; // 回到学习阶段
      due = now + AGAIN_DELAY;
      break;
    case 'hard':
      ease -= 0.15;
      // 新词答"模糊"给半天，否则和"记得"都是 1 天，按钮上预告的时间一模一样，选哪个都没区别
      interval = prevInterval > 0 ? Math.max(prevInterval * 1.2, prevInterval + 1) : 0.5;
      due = now + interval * DAY;
      break;
    case 'easy':
      ease += 0.15;
      interval = prevInterval > 0 ? prevInterval * ease * 1.3 : 3;
      due = now + interval * DAY;
      break;
    case 'good':
    default:
      interval = prevInterval > 0 ? prevInterval * ease : 1;
      due = now + interval * DAY;
      break;
  }

  ease = Math.min(MAX_EASE, Math.max(MIN_EASE, ease));
  interval = Math.min(365, Math.round(interval * 100) / 100);
  if (grade !== 'again') due = now + interval * DAY;

  return {
    ease: Math.round(ease * 100) / 100,
    interval,
    due,
    reps: (Number(entry?.reps) || 0) + 1,
    lapses: (Number(entry?.lapses) || 0) + (grade === 'again' ? 1 : 0),
    lastGrade: grade,
    lastReviewedAt: now
  };
}

/** 词条状态：new 新词 / learning 学习中 / mastered 已掌握 */
export function statusOf(entry) {
  if (!entry?.reps) return 'new';
  return entry.interval >= MASTERED_INTERVAL ? 'mastered' : 'learning';
}

/**
 * 把间隔（天）说成人话。注意 0.99 天要说"1 天"而不是"24 小时"——
 * 排程算出来的间隔常常差几毫秒到不了整天，直接按小时取整会冒出"24 小时"这种别扭说法。
 */
export function describeInterval(days) {
  const d = Number(days) || 0;
  if (d <= 0) return '10 分钟';
  if (d < 1) {
    const hours = Math.round(d * 24);
    if (hours < 24) return `${Math.max(1, hours)} 小时`;
  }
  if (d < 30) return `${Math.max(1, Math.round(d))} 天`;
  if (d < 365) return `${Math.round((d / 30) * 10) / 10} 个月`;
  return `${Math.round((d / 365) * 10) / 10} 年`;
}

/** 到期时间说成人话，用在词表里 */
export function describeDue(due, now = Date.now()) {
  const diff = Number(due) - now;
  if (diff <= 0) return '待复习';
  return `${describeInterval(diff / DAY)}后复习`;
}
