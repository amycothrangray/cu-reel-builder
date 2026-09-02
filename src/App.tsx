import { NavLink, Route, Routes } from 'react-router-dom';
import { ToastHost } from './components/ToastHost';
import { HomeScreen } from './screens/Home';
import { NewReelScreen } from './screens/NewReel';
import { PhotoReviewScreen } from './screens/PhotoReview';
import { TemplatePickScreen } from './screens/TemplatePick';
import { EditorScreen } from './screens/Editor';
import { ExportScreen } from './screens/Export';
import { BrandScreen } from './screens/Brand';
import { RestrictionsScreen } from './screens/Restrictions';
import { SettingsScreen } from './screens/Settings';

const navLink = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '');

function TabIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export default function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="wordmark">
            Reel Studio
          </NavLink>
          <nav>
            <NavLink to="/" end className={navLink}>
              Home
            </NavLink>
            <NavLink to="/brand" className={navLink}>
              Brand
            </NavLink>
            <NavLink to="/restrictions" className={navLink}>
              Photo Restrictions
            </NavLink>
            <NavLink to="/settings" className={navLink}>
              Settings
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomeScreen />} />
          <Route path="/new" element={<NewReelScreen />} />
          <Route path="/reel/:reelId/review" element={<PhotoReviewScreen />} />
          <Route path="/reel/:reelId/template" element={<TemplatePickScreen />} />
          <Route path="/reel/:reelId/edit" element={<EditorScreen />} />
          <Route path="/reel/:reelId/export" element={<ExportScreen />} />
          <Route path="/brand" element={<BrandScreen />} />
          <Route path="/restrictions" element={<RestrictionsScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
        </Routes>
      </main>

      <nav className="tabbar">
        <NavLink to="/" end className={navLink}>
          <TabIcon d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5" />
          Home
        </NavLink>
        <NavLink to="/new" className={navLink}>
          <TabIcon d="M12 5v14M5 12h14" />
          New Reel
        </NavLink>
        <NavLink to="/brand" className={navLink}>
          <TabIcon d="M12 3a9 9 0 1 0 9 9c0-1.5-1.2-2.5-2.7-2.5H16a2.5 2.5 0 0 1 0-5h.5" />
          Brand
        </NavLink>
        {/* Photo Restrictions belongs on the phone too — it is the one screen
            that must never be out of reach when a parent asks for a child to
            be kept out of a post. */}
        <NavLink to="/restrictions" className={navLink}>
          <TabIcon d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3Z" />
          Restrictions
        </NavLink>
        <NavLink to="/settings" className={navLink}>
          <TabIcon d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.5 4a8.4 8.4 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a8.6 8.6 0 0 0-2.2-1.3L15.5 3h-4l-.4 2.5a8.6 8.6 0 0 0-2.2 1.3l-2.3-1-2 3.4 2 1.5a8.4 8.4 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-1c.7.5 1.4 1 2.2 1.3l.4 2.5h4l.4-2.5a8.6 8.6 0 0 0 2.2-1.3l2.3 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3Z" />
          Settings
        </NavLink>
      </nav>

      <ToastHost />
    </div>
  );
}
