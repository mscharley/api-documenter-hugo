// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

import { PackageJsonLookup } from '@rushstack/node-core-library';
import { Colorize } from '@rushstack/terminal';

import { ApiDocumenterCommandLine } from './cli/ApiDocumenterCommandLine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const myPackageVersion: string = PackageJsonLookup.loadOwnPackageJson(__dirname).version;

console.log(
	os.EOL +
		Colorize.bold(
			`api-documenter-hugo ${myPackageVersion} ${Colorize.cyan(' - https://github.com/mscharley/api-documenter-hugo')}${os.EOL}`,
		),
);

const parser: ApiDocumenterCommandLine = new ApiDocumenterCommandLine();

parser.execute().catch(console.error); // CommandLineParser.execute() should never reject the promise
