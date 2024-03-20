// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { ApiDocumenterCommandLine } from './ApiDocumenterCommandLine.js';
import { BaseAction } from './BaseAction.js';
import { HugoDocumenter } from '../documenters/HugoDocumenter.js';

export class HugoAction extends BaseAction {
	public constructor(parser: ApiDocumenterCommandLine) {
		super({
			actionName: 'hugo',
			summary: 'Generate documentation as Markdown files (*.md) compatible with Hugo',
			documentation:
				'Generates API documentation as a collection of files in' +
				' Markdown format, suitable for example for publishing using the hugo static site generator.',
		});
	}

	protected async onExecute(): Promise<void> {
		// override
		const { apiModel, outputFolder } = this.buildApiModel();

		const markdownDocumenter: HugoDocumenter = new HugoDocumenter({
			apiModel,
			documenterConfig: undefined,
			outputFolder,
		});
		markdownDocumenter.generateFiles();
	}
}
