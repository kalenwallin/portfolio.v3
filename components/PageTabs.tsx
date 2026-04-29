import cs from 'classnames'

import styles from './PageTabs.module.css'

export interface Tab {
  id: string
  label: string
}

interface PageTabsProps {
  tabs: Tab[]
  activeTab: string
  onTabChange: (id: string) => void
}

export function PageTabs({ tabs, activeTab, onTabChange }: PageTabsProps) {
  return (
    <nav className={styles.tabs} aria-label='Page sections'>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type='button'
          className={cs(styles.tab, activeTab === tab.id && styles.active)}
          onClick={() => onTabChange(tab.id)}
          aria-current={activeTab === tab.id ? 'page' : undefined}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )
}
