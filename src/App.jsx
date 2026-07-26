import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import { useAuth } from "./context/AuthContext";
import DashboardPage from "./pages/Dashboard";
import CharactersPage from "./pages/Characters";
import LootPage from "./pages/Loot";
import InventoryPage from "./pages/Inventory";
import ShoppingPage from "./pages/Shopping";
import BuffProfilesPage from "./pages/BuffProfiles";
import RaidsPage from "./pages/Raids";
import RestedXpPage from "./pages/RestedXp";
import SettingsPage from "./pages/Settings";
import AdminPage from "./pages/Admin";
import WarriorSimPage from "./pages/WarriorSim";
import RogueSimPage from "./pages/RogueSim";
import MageSimPage from "./pages/MageSim";

function App() {
  const { user, loading, hasFirebaseConfig, signInWithGoogle } = useAuth();

  if (loading) {
    return (
      <Layout>
        <section className="panel">
          <h2>Loading</h2>
          <p className="subtitle">Checking your sign-in session...</p>
        </section>
      </Layout>
    );
  }

  if (!hasFirebaseConfig) {
    return (
      <Layout>
        <section className="panel">
          <h2>Configuration Required</h2>
          <p className="subtitle">Firebase env vars are missing. Copy .env.example into .env.local.</p>
        </section>
      </Layout>
    );
  }

  if (!user) {
    return (
      <Layout>
        <section className="panel">
          <h2>Sign In Required</h2>
          <p className="subtitle">Sign in with Google to use the page.</p>
          <div className="row-actions">
            <button type="button" onClick={signInWithGoogle}>
              Sign In with Google
            </button>
          </div>
        </section>
      </Layout>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/characters" element={<CharactersPage />} />
        <Route path="/raids" element={<RaidsPage />} />
        <Route path="/loot" element={<LootPage />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/shopping" element={<ShoppingPage />} />
        <Route path="/buff-profiles" element={<BuffProfilesPage />} />
        <Route path="/rested" element={<RestedXpPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/sim/warrior" element={<WarriorSimPage />} />
        <Route path="/sim/rogue" element={<RogueSimPage />} />
        <Route path="/sim/mage" element={<MageSimPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default App;
