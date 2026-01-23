'use client'

import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { CheckCircle, Loader2 } from 'lucide-react'

export default function CliLoginPage() {
  const searchParams = useSearchParams()
  const deviceCode = searchParams.get('device_code')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function approveDevice() {
      if (!deviceCode) {
        setError('Device code is missing from the URL.')
        setLoading(false)
        return
      }

      const response = await fetch('/api/auth/cli/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ device_code: deviceCode }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        setError(errorData.error || 'Failed to approve device.')
      }
      setLoading(false)
    }

    approveDevice()
  }, [deviceCode])

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white">
      <div className="p-8 bg-gray-900 rounded-lg shadow-md text-center max-w-md w-full">
        <h1 className="text-2xl font-bold mb-4">CLI Authentication</h1>
        {loading && (
          <div className="flex flex-col items-center justify-center">
            <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
            <p className="text-gray-400">
              Approving login attempt...
            </p>
          </div>
        )}
        {!loading && !error && (
          <div className="flex flex-col items-center justify-center">
            <CheckCircle className="h-12 w-12 text-green-500 mb-4" />
            <p className="text-lg text-gray-300 mb-2">
              Authentication successful!
            </p>
            <p className="text-gray-400">
              You can now close this window and return to your terminal.
            </p>
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center justify-center">
            <p className="text-red-500">{error}</p>
          </div>
        )}
      </div>
    </div>
  )
}
