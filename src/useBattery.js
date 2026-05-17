import { useState, useEffect } from 'react'

export function useBattery() {
  const [battery, setBattery] = useState(null)

  useEffect(() => {
    if (!navigator.getBattery) return
    let bat = null
    function update() {
      if (!bat) return
      setBattery({ level: bat.level, charging: bat.charging })
    }
    navigator.getBattery().then(b => {
      bat = b
      update()
      b.addEventListener('levelchange', update)
      b.addEventListener('chargingchange', update)
    }).catch(() => {})
    return () => {
      if (bat) {
        bat.removeEventListener('levelchange', update)
        bat.removeEventListener('chargingchange', update)
      }
    }
  }, [])

  return battery
}
