import { NavLink, Outlet } from 'react-router-dom';

export default function SettingsLayout() {
  return (
    <section className="reading settings-layout">
      <div className="settings-head">
        <h2>Settings</h2>
        <nav className="settings-nav" aria-label="Settings">
          <NavLink to="/settings" end>General</NavLink>
          <NavLink to="/settings/vaults">Vaults</NavLink>
        </nav>
      </div>
      <Outlet />
    </section>
  );
}
