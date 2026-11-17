export interface SpecialInfo {
  id: string
  /** 所属册（七上 g7a / 七下 g7b），用于今日页分组展示 */
  book: 'g7a' | 'g7b'
  title: string
  sourceUrl: string
}

export const SPECIALS: SpecialInfo[] = [
  { id: 'g7a-present', book: 'g7a', title: '一般现在时与句子种类', sourceUrl: 'g7a-present/' },
  { id: 'g7a-nouns', book: 'g7a', title: '名词与所有格', sourceUrl: 'g7a-nouns/' },
  { id: 'g7a-numbers', book: 'g7a', title: '数词与介词', sourceUrl: 'g7a-numbers/' },
  { id: 'g7a-articles', book: 'g7a', title: '冠词与代词', sourceUrl: 'g7a-articles/' },
  { id: 'g7b-adjadv', book: 'g7b', title: '形容词与副词', sourceUrl: 'g7b-adjadv/' },
  { id: 'g7b-nouns', book: 'g7b', title: '名词（复数与可数性）', sourceUrl: 'g7b-nouns/' },
  { id: 'g7b-pronouns-modals', book: 'g7b', title: '物主代词与情态动词', sourceUrl: 'g7b-pronouns-modals/' },
  { id: 'g7b-tenses', book: 'g7b', title: '现在进行时与一般过去时', sourceUrl: 'g7b-tenses/' },
]
