/** Факт из личного банка памяти — общий тип для main, preload и рендерера. */
export interface MemoryFact {
  id: string;
  /** Сам факт, как его сохранил Hindsight. */
  text: string;
  /** Тип факта по классификации Hindsight; пустая строка, если не указан. */
  factType: string;
  tags: string[];
  /** Действующий факт или отменённый более поздним. */
  state: string;
  /** Когда факт был упомянут, мс от эпохи; 0 — дата неизвестна. */
  at: number;
}

export interface MemoryPage {
  items: MemoryFact[];
  total: number;
}
