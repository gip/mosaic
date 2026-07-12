import { Outlet } from 'react-router-dom';

export default function SettingsLayout() {
  return (
    <section className="reading settings-layout">
      <div className="settings-head">
        <h2>Settings</h2>
      </div>
      <Outlet />
    </section>
  );
}
