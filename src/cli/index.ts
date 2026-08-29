#!/usr/bin/env node
import {Command} from 'commander';

const program = new Command()
  .name('antibody')
  .description('Recover and causally verify regression tests omitted from merged bug fixes.')
  .version('0.0.0');

program.parse();
