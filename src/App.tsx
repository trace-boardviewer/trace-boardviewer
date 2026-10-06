import { useWorkspace } from './app/useWorkspace';
import Shell from './components/workspace/Shell';

/** Application root: the core (`useWorkspace`, src/app/**) owns all state and side effects; the shell only renders it. */
export default function App() {
  return <Shell api={useWorkspace()} />;
}
