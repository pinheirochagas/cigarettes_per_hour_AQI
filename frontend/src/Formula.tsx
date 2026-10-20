import { useEffect, useRef } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

export default function Formula() {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (element.current) katex.render(
      String.raw`\text{Cigarette equivalent} \approx \frac{\mathrm{PM}_{2.5}\times\text{hours}}{22\times24}`,
      element.current, { displayMode: true, throwOnError: false, trust: false },
    )
  }, [])
  return <div className="formula" ref={element} />
}
