// Admin.jsx — redirects to the unified Coaching Dashboard.
import { Navigate } from 'react-router-dom'

export default function Admin() {
  return <Navigate to="/dashboard" replace />
}
