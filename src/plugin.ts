/**
 * Voiden Stitch Plugin
 *
 * Batch-run multiple .void files with aggregated assertion results.
 * Registers the /stitch block node, results sidebar tab, and slash command.
 */

import type { CorePluginContext } from '@voiden/sdk/ui';

export default function createVoidenStitchPlugin(context: CorePluginContext) {
  return {
    onload: async () => {
      // 1. Import and create the StitchNode
      const { NodeViewWrapper, RequestBlockHeader } = context.ui.components;
      const { createStitchNode } = await import('./nodes/StitchNode');

      // Get environment hooks from context (must only be used inside React components / node views)
      const { useActiveEnvironment, useEnvironments } = (context as any).helpers;

      // Open the response panel (stitch results now render inside it)
      const openResultsTab = async () => {
        try {
          const responsePanelPosition = context.ui.getResponsePanelPosition();

          if (responsePanelPosition === 'bottom') {
            context.ui.setBottomActiveView('sidebar');
            context.ui.openBottomPanel();
            context.ui.expandBottomPanel();
          } else {
            context.ui.openRightPanel();
          }

          // Activate the responsePanel tab specifically (not just the first tab)
          const tabs = await (window as any).electron?.sidebar?.getTabs?.("right");
          const responsePanelTab = (tabs?.tabs as any[])?.find((t: any) => t.type === 'responsePanel');
          if (responsePanelTab) {
            await (window as any).electron?.sidebar?.activateTab?.("right", responsePanelTab.id);
          }
        } catch { /* best effort */ }
      };

      const StitchNode = createStitchNode(
        NodeViewWrapper,
        RequestBlockHeader,
        useActiveEnvironment,
        useEnvironments,
        openResultsTab,
      );

      // 2. Register TipTap extension
      context.registerVoidenExtension(StitchNode);

      // 3. Register display names
      context.registerNodeDisplayNames({
        'stitch': 'Stitch Runner',
      });

      // 4. Register block owner for paste handling
      context.paste.registerBlockOwner({
        blockType: 'stitch',
        allowExtensions: false,
        handlePasteInside: () => false,
        processBlock: (block: any) => block,
      });

      // 5. Register slash command
      context.addVoidenSlashGroup({
        name: 'stitch',
        title: 'Stitch Runner',
        commands: [
          {
            name: 'stitch',
            label: 'Stitch Runner',
            slash: '/stitch',
            singleton: false,
            aliases: ['batch', 'suite', 'collection-runner'],
            description: 'Insert a stitch block to batch-run multiple .void files',
            action: (editor: any) => {
              const range = {
                from: editor.state.selection.$from.pos,
                to: editor.state.selection.$to.pos,
              };
              editor
                .chain()
                .focus()
                .deleteRange(range)
                .insertContent([{ type: 'stitch' }])
                .run();
            },
          },
        ],
      });

      // 6. Register this plugin's results section in the response panel (generic registry —
      //    no plugin ID is hardcoded in ResponsePanelContainer).
      const { StitchResultsSidebar } = await import('./components/StitchResultsSidebar');
      const { stitchStore } = await import('./lib/stitchStore');

      // Still expose helpers so other plugins can access stitchStore via context.helpers.from()
      context.exposeHelpers({ StitchResultsSidebar, stitchStore } as any);

      (context as any).registerResponsePanelSection({
        id: 'stitch-runner',
        label: 'Stitch Runner',
        component: StitchResultsSidebar,
        hasResults: (tabId: string | undefined) => {
          const run = stitchStore.getRun(tabId);
          return run.status !== 'idle' && !!run.id;
        },
        subscribe: (listener: () => void) => stitchStore.subscribe(listener),
      });
    },

    onunload: async () => {
      // Cleanup: clear any in-progress state
      const { stitchStore } = await import('./lib/stitchStore');
      const run = stitchStore.getRun();
      if (run.status === 'running') {
        stitchStore.cancelRun();
      }
    },
  };
}
