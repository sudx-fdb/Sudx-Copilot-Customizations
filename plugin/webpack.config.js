//@ts-check
'use strict';

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

/** @type {import('webpack').Configuration} */
const config = {
  target: 'node',
  mode: 'none',

  entry: './src/extension.ts',

  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    clean: true,
  },

  externals: {
    vscode: 'commonjs vscode',
  },

  resolve: {
    extensions: ['.ts', '.js'],
  },

  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
            },
          },
        ],
      },
    ],
  },

  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'templates',
          to: 'templates',
          noErrorOnMissing: true,
        },
        {
          from: 'media',
          to: 'media',
          noErrorOnMissing: true,
        },
      ],
    }),
    new webpack.DefinePlugin({
      'process.env.EXTENSION_VERSION': JSON.stringify(
        require('./package.json').version
      ),
      'process.env.BUILD_DATE': JSON.stringify(new Date().toISOString()),
    }),
  ],

  devtool: 'nosources-source-map',

  optimization: {
    minimize: false,
  },

  infrastructureLogging: {
    level: 'log',
  },
};

module.exports = (env, argv) => {
  if (argv.mode === 'production') {
    config.optimization.minimize = true;
    config.devtool = 'nosources-source-map';
  } else {
    config.devtool = 'source-map';
  }
  return config;
};
