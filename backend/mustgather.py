from flask import Blueprint

mustgather = Blueprint('mustgather', __name__, url_prefix='/mustgather')

# Add mustgather-specific routes here if needed
# Example:
# @mustgather.route('/status')
# def status():
#     return jsonify({'status': 'ok', 'type': 'mustgather'})
