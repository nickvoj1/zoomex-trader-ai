import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

export default function Index() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen gradient-mesh flex items-center justify-center">
        <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return session ? <Navigate to="/dashboard" replace /> : <Navigate to="/auth" replace />;
}
