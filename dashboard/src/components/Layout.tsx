import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import "./Layout.css";

export default function Layout() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="layout">
      <nav className="layout-nav">
        <div className="nav-brand">
          <NavLink to="/">Bot Dashboard</NavLink>
        </div>
        <ul className="nav-links">
          <li><NavLink to="/" end>Overview</NavLink></li>
          <li><NavLink to="/users">Users</NavLink></li>
          <li><NavLink to="/reminders">Reminders</NavLink></li>
          <li><NavLink to="/messages">Messages</NavLink></li>
          <li><NavLink to="/usage">Cost</NavLink></li>
        </ul>
        <button type="button" className="nav-logout" onClick={handleLogout}>
          Log out
        </button>
      </nav>
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  );
}
