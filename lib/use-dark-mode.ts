import useDarkModeImpl from '@fisch0920/use-dark-mode'
import { useEffect, useState } from 'react'

export function useDarkMode() {
  const darkMode = useDarkModeImpl(false, { classNameDark: 'dark-mode' })

  // Prevent hydration mismatch: always render light-mode on the first
  // client pass (matching SSR), then sync to the real value after mount.
  const [hasMounted, setHasMounted] = useState(false)
  useEffect(() => {
    setHasMounted(true)
  }, [])

  return {
    isDarkMode: hasMounted ? darkMode.value : false,
    toggleDarkMode: darkMode.toggle
  }
}
