jest.mock('widgets/utility/utility.scss', () => ({}));
jest.mock('widgets', () => ({
  __esModule: true,
  default: { createContext: jest.fn(() => ({})) },
  Button: () => null,
  IconButton: () => null,
  IconSet: {},
  Menu: () => null,
  MenuItem: () => null,
  Toolbar: () => null,
  ToolbarButton: () => null,
}));
jest.mock('widgets/button', () => ({ Button: () => null }));
jest.mock('widgets/icons', () => ({ IconButton: () => null, IconSet: {} }));
jest.mock('widgets/menus', () => ({ Menu: () => null, MenuItem: () => null }));
jest.mock('widgets/toolbar', () => ({ Toolbar: () => null, ToolbarButton: () => null }));
jest.mock('src/frontend/contexts/StoreContext', () => ({ useStore: jest.fn() }));
global.window = {
  setTimeout: global.setTimeout.bind(global),
  clearTimeout: global.clearTimeout.bind(global),
};
