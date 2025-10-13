import 'katex/dist/katex.min.css'
import 'prismjs/themes/prism-coy.css'
import 'react-notion-x/src/styles.css'
import 'styles/notion.css'
import 'styles/prism-theme.css'
import 'styles/global.css'

import type { AppProps } from 'next/app'
import { Analytics } from '@vercel/analytics/react'
import * as React from 'react'

import { bootstrap } from '@/lib/bootstrap-client'
import { isServer } from '@/lib/config'

if (!isServer) {
  bootstrap()
}

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      {/* Vercel Analytics */}
      <Analytics />
    </>
  )
}
