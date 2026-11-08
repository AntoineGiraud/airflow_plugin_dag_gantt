const path = require('path');

module.exports = {
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'dag-gantt-widget.js',
    library: {
      name: 'DagGanttWidget',
      type: 'window',
      export: 'default'
    }
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env', '@babel/preset-react']
          }
        }
      }
    ]
  },
  resolve: {
    extensions: ['.js', '.jsx']
  },
  externals: {
    // Bibliothèques exposées par l'UI Airflow 3.3 sur globalThis
    // (vérifié dans le bundle UI : Reflect.set(globalThis, 'React'|'ReactDOM'|
    // 'ReactJSXRuntime'|'ReactRouterDOM'|'ChakraUI'|'EmotionReact', ...)).
    // Rien n'est bundlé : on consomme celles de l'hôte → thème/branding cohérents.
    react: 'React',
    'react-dom': 'ReactDOM',
    'react/jsx-runtime': 'ReactJSXRuntime',
    'react/jsx-dev-runtime': 'ReactJSXRuntime',
    '@chakra-ui/react': 'ChakraUI',
    '@emotion/react': 'EmotionReact',
    'react-router-dom': 'ReactRouterDOM'
  }
};
