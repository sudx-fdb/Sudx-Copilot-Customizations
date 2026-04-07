import * as vscode from 'vscode';
import { SudxLogger } from '../utils/logger';
import { SudxSettings } from '../config/settings';
import { StateManager } from '../config/state';
import { PathUtils } from '../utils/paths';
import { STRINGS } from '../constants';

const MODULE = 'AgentActivator';

export class AgentActivator {
  private logger: SudxLogger;
  private settings: SudxSettings;
  private paths: PathUtils;

  constructor(
    logger: SudxLogger,
    settings: SudxSettings,
    _state: StateManager,
    paths: PathUtils
  ) {
    this.logger = logger;
    this.settings = settings;
    this.paths = paths;
  }

  async isAgentDeployed(): Promise<boolean> {
    this.logger.debug(MODULE, 'Checking if agent is deployed');

    const deployPath = this.settings.getDeployPath();
    const agentPath = this.paths.toAbsolutePath(
      `${deployPath}/agents/sudx.agent.md`
    );

    if (!agentPath) {
      this.logger.debug(MODULE, 'Could not resolve agent path');
      return false;
    }

    const exists = await this.paths.pathExists(agentPath);
    this.logger.debug(MODULE, 'Agent deployed status', { exists, agentPath });
    return exists;
  }

  isActivationEnabled(): boolean {
    const enabled = this.settings.getAutoActivateAgent();
    this.logger.debug(MODULE, 'Agent activation enabled', { enabled });
    return enabled;
  }

  async activateAgent(): Promise<void> {
    this.logger.info(MODULE, 'Activating Sudx Copilot Customizations agent');

    if (!this.isActivationEnabled()) {
      this.logger.info(MODULE, 'Agent activation disabled via opt-out');
      return;
    }

    const deployed = await this.isAgentDeployed();
    if (!deployed) {
      this.logger.warn(MODULE, 'Agent file not deployed — skipping activation');
      return;
    }

    // Check if Copilot Chat is available
    const copilotExt = vscode.extensions.getExtension('github.copilot-chat');
    if (!copilotExt) {
      this.logger.warn(MODULE, 'GitHub Copilot Chat extension not found');
      // Fire-and-forget — do not block caller
      vscode.window.showWarningMessage(STRINGS.NOTIFY_COPILOT_NOT_FOUND, 'OK');
      return;
    }

    // Open Copilot Chat with Sudx Copilot Customizations agent mode selected
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        mode: 'Sudx Copilot Customizations',
      });
      this.logger.info(MODULE, 'Copilot Chat opened with Sudx Copilot Customizations agent mode');
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to open chat with agent mode', err);
      // Fallback: just open chat without agent mode
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open');
        this.logger.info(MODULE, 'Copilot Chat opened (fallback without agent mode)');
      } catch (fallbackErr) {
        this.logger.error(MODULE, 'Failed to open Copilot Chat', fallbackErr);
      }
    }

    // Fire-and-forget notification — do not block deploy pipeline
    vscode.window
      .showInformationMessage(
        STRINGS.NOTIFY_AGENT_ACTIVATED,
        'OK',
        'Disable auto-activate'
      )
      .then((action) => {
        if (action === 'Disable auto-activate') {
          this.logger.info(MODULE, 'User opted out of auto-activation');
          this.settings.setAutoActivateAgent(false);
        }
      });

    this.logger.info(MODULE, 'Agent activation complete');
  }

  async deactivateAgent(): Promise<void> {
    this.logger.info(MODULE, 'Deactivating agent auto-activation');
    await this.settings.setAutoActivateAgent(false);
  }

  async getActivationStatus(): Promise<{
    deployed: boolean;
    activated: boolean;
    optedOut: boolean;
  }> {
    const deployed = await this.isAgentDeployed();
    const optedOut = !this.isActivationEnabled();
    return {
      deployed,
      activated: deployed && !optedOut,
      optedOut,
    };
  }
}
