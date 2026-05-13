// Admin.jsx — redirects to the unified Coaching Command Center.
// All admin/coaching functionality now lives at /admin/clients.
import { Navigate } from 'react-router-dom'

export default function Admin() {
  return <Navigate to="/admin/clients" replace />
}
